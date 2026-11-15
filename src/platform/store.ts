import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * The platform's one table, as the little the platform asks of it.
 *
 * Every row has a partition (`PK`) and a name within it (`SK`); the layout is
 * set out in infra/dynamodb.tf. `Table` is the whole of what the platform
 * needs from a table, so the tests run the platform against `MemoryTable`
 * with nothing of AWS in reach, and `DynamoTable` is the same five verbs over
 * DynamoDB.
 */
export interface Row {
  PK: string;
  SK: string;
  /** Epoch seconds after which DynamoDB may delete the row by itself. */
  ttl?: number;
  [key: string]: unknown;
}

export interface Table {
  get(pk: string, sk: string): Promise<Row | null>;
  /** Write a row. With `ifAbsent`, only when no row has its key: false when one did. */
  put(row: Row, options?: { ifAbsent?: boolean }): Promise<boolean>;
  /** Remove a row. With `ifPresent`, says whether there was one to remove: false when not. */
  delete(pk: string, sk: string, options?: { ifPresent?: boolean }): Promise<boolean>;
  /** Every row of a partition, in the order of their names; `prefix` narrows it to the names that start with it. */
  query(pk: string, options?: { prefix?: string }): Promise<Row[]>;
  /** Set fields on a row that exists (a value of `undefined` removes the field). Null when there is no such row. */
  update(pk: string, sk: string, patch: Record<string, unknown>): Promise<Row | null>;
}

/** A table in memory: the tests', and nothing else's. */
export class MemoryTable implements Table {
  private rows = new Map<string, Row>();

  private key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  async get(pk: string, sk: string): Promise<Row | null> {
    const row = this.rows.get(this.key(pk, sk));
    return row ? structuredClone(row) : null;
  }

  async put(row: Row, options: { ifAbsent?: boolean } = {}): Promise<boolean> {
    const key = this.key(row.PK, row.SK);
    if (options.ifAbsent && this.rows.has(key)) return false;
    this.rows.set(key, structuredClone(row));
    return true;
  }

  async delete(pk: string, sk: string): Promise<boolean> {
    return this.rows.delete(this.key(pk, sk));
  }

  async query(pk: string, options: { prefix?: string } = {}): Promise<Row[]> {
    return [...this.rows.values()]
      .filter((row) => row.PK === pk && (options.prefix === undefined || row.SK.startsWith(options.prefix)))
      .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0))
      .map((row) => structuredClone(row));
  }

  async update(pk: string, sk: string, patch: Record<string, unknown>): Promise<Row | null> {
    const key = this.key(pk, sk);
    const row = this.rows.get(key);
    if (!row) return null;
    const next: Row = { ...row };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete next[field];
      else next[field] = structuredClone(value);
    }
    this.rows.set(key, next);
    return structuredClone(next);
  }

  /** Every row, for a test to look at. */
  all(): Row[] {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

function isConditionFailure(error: unknown): boolean {
  return (error as { name?: string })?.name === "ConditionalCheckFailedException";
}

export class DynamoTable implements Table {
  private readonly client: DynamoDBDocumentClient;

  constructor(private readonly tableName: string, client?: DynamoDBDocumentClient) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get(pk: string, sk: string): Promise<Row | null> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { PK: pk, SK: sk } }));
    return (result.Item as Row | undefined) ?? null;
  }

  async put(row: Row, options: { ifAbsent?: boolean } = {}): Promise<boolean> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: row,
        ...(options.ifAbsent ? { ConditionExpression: "attribute_not_exists(PK)" } : {}),
      }));
      return true;
    } catch (error) {
      if (options.ifAbsent && isConditionFailure(error)) return false;
      throw error;
    }
  }

  async delete(pk: string, sk: string, options: { ifPresent?: boolean } = {}): Promise<boolean> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: pk, SK: sk },
        ...(options.ifPresent ? { ConditionExpression: "attribute_exists(PK)" } : {}),
      }));
      return true;
    } catch (error) {
      if (options.ifPresent && isConditionFailure(error)) return false;
      throw error;
    }
  }

  async query(pk: string, options: { prefix?: string } = {}): Promise<Row[]> {
    const rows: Row[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: options.prefix === undefined ? "PK = :pk" : "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: options.prefix === undefined ? { ":pk": pk } : { ":pk": pk, ":prefix": options.prefix },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      rows.push(...((result.Items as Row[] | undefined) ?? []));
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return rows;
  }

  async update(pk: string, sk: string, patch: Record<string, unknown>): Promise<Row | null> {
    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    Object.entries(patch).forEach(([field, value], index) => {
      names[`#f${index}`] = field;
      if (value === undefined) {
        removes.push(`#f${index}`);
      } else {
        sets.push(`#f${index} = :v${index}`);
        values[`:v${index}`] = value;
      }
    });
    if (sets.length === 0 && removes.length === 0) return this.get(pk, sk);
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { PK: pk, SK: sk },
        UpdateExpression: [sets.length ? `SET ${sets.join(", ")}` : "", removes.length ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean).join(" "),
        ExpressionAttributeNames: names,
        ...(sets.length ? { ExpressionAttributeValues: values } : {}),
        ConditionExpression: "attribute_exists(PK)",
        ReturnValues: "ALL_NEW",
      }));
      return (result.Attributes as Row | undefined) ?? null;
    } catch (error) {
      if (isConditionFailure(error)) return null;
      throw error;
    }
  }
}
