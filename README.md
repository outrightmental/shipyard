[![Deploy](https://github.com/outrightmental/shipyard/actions/workflows/deploy.yml/badge.svg)](https://github.com/outrightmental/shipyard/actions/workflows/deploy.yml)
[![Test](https://github.com/outrightmental/shipyard/actions/workflows/test.yml/badge.svg)](https://github.com/outrightmental/shipyard/actions/workflows/test.yml)

# Shipyard

**A distributed agentic coding factory, centralized for the whole organization.**

Shipyard is one control surface, at [shipyard.outright.io](https://shipyard.outright.io), that many machines hosting coding agents subscribe to. You write issues. A fleet of machines — each one a laptop or a server signed in to one Claude account — works them: implements each issue, opens a pull request, reviews its own diff, fixes what needs fixing, and merges. Shipyard is where you see all of it at once, decide what each machine works on, and make the few decisions that are yours to make.

It is [Shipyard's engine](design/SHIPYARD.md) run as a service. The engine does all of this on one machine, for whoever is sitting at it; it is what every fleet member runs, unchanged in how it works an issue. Shipyard is what was missing for more than one machine: somewhere central that knows the fleet, hands out the work, and adds every machine's dashboard up into one.

## What you see

```text
┌──────────┬────────────────────────────────────────────────────┬───────────────┐
│ SHIPYARD │ ATLAS 2/4   ◔ CLAUDE 5H 38%  RESETS IN 2H 23M       │ INBOX         │
│          │   ◉ reviewing   #212 Rate-limit the search endpoint │               │
│ Dashboard│   ◉ implementing #88 Keep the filter bar in view    │ Fleet member  │
│ Fleet    │   ○ idle  ○ idle                                    │ offline       │
│ Repos    │ BOREALIS 0/3 ● CLAUDE LIMIT  waiting 1h 35m …       │  cirrus       │
│          │   ○ idle  ○ idle  ○ idle                            │               │
│          │ CIRRUS   offline · last heard from 42m ago          │ Unassigned    │
│          │                                                     │ repository    │
│          │ ATLAS-API 4   2 queued · 2 waiting                  │  acme/orphan  │
│          │   #219 Paginate the audit log export                │               │
│          │   #214 Return 409 instead of 500 …   awaiting you   │ Approve to    │
│ Sign out │ XJ-MUSIC 3    3 queued                              │ merge         │
│ Collapse │   #402 Crossfade between segments …  checks failing │  [ APPROVE ]  │
└──────────┴────────────────────────────────────────────────────┴───────────────┘
```

- **Dashboard** is Shipyard's, as it is drawn — [the field and the inbox](design/DASHBOARD.md) — for the whole fleet. Work that is burning is at the top, **grouped by the fleet member burning it**, with that member's own Claude usage in its heading, and how its machine is doing along the heading's right-hand end. Everything else is below, grouped by repository.
- **Fleet** is the machines: which are online, the commit each runs, its Claude usage, how many cylinders it has, how its machine is doing, what it is assigned.
- **Repositories** is where Shipyard is connected to GitHub and where work is given out: subscribe to a repository, and assign it to a fleet member.
- **The inbox**, down the right-hand edge, is everything waiting on a person: a PR to approve, and whatever is stopping work across the fleet.

The menu down the left folds to its icons.

## How it fits together

```text
        you ─────────────▶ shipyard.outright.io ◀──── GitHub (the Shipyard app)
                            the console · the platform
                                 ▲          │
              every engine event │          │ assignments · decisions · the commit to run
                    (HTTPS, up)  │          ▼  (WebSocket, down)
                 ┌───────────────┴──────────────────┐
                 │                                  │
           fleet member                       fleet member          …one per Claude account
           atlas (a laptop)                   borealis (a server)
           Shipyard's engine pool              Shipyard's engine pool
           acme/atlas-api, acme/atlas-web     acme/xj-music
```

Three rules make the whole thing simple:

1. **A fleet member is one machine and one Claude account.** Its Claude usage is its own, which is why usage is shown per member.
2. **A repository is assigned to exactly one fleet member.** Subscribing to a repository puts its issues on the dashboard; it gets no work done until it is assigned. A member starts assigned to nothing.
3. **The main dashboard is the sum of every member's own.** Because of rule 2, two members never show the same repository, and adding them up is all there is to it.

Each fleet member also opens its own dashboard on its own screen: the same picture, for its own repositories only, **read-only**. It shows what is waiting on a person, and says to approve it in Shipyard.

Shipyard says so in the inbox when a subscribed repository is assigned to no one, when a fleet member is assigned nothing, and when a member with work is offline.

## Kicking it off

Everything below happens once.

### 1. Sign in

Open [shipyard.outright.io](https://shipyard.outright.io). The operator's account was created when the platform was first deployed, and an invitation with a temporary password went to the operator's address. You choose your own password on first sign-in. Nobody can sign up: an operator is added in `infra/cognito.tf`.

### 2. Connect GitHub

**Repositories → Create the GitHub App.** Shipyard works on GitHub as a GitHub App of its own, made for your organization. Creating it takes one confirmation on GitHub; nothing secret is typed or pasted. GitHub sends you back, and Shipyard asks you to **Install on GitHub**: choose the repositories it may work on.

An app, rather than someone's token, because its access is exactly the repositories it is installed on, what it does on GitHub is done in its own name, and no machine ever has to hold a GitHub credential.

### 3. Subscribe to repositories

**Repositories** lists every repository the app can see. **Subscribe** to the ones Shipyard should work. Their open issues appear on the dashboard at once, dimmed and marked `unassigned`.

### 4. Enroll a machine

**Fleet → Enroll a machine** gives you a code that lasts fifteen minutes and enrolls one machine, once. On the machine — signed in to the Claude account it is to work with (`claude login`), with Node 22 or later and git:

```bash
git clone https://github.com/outrightmental/shipyard.git shipyard-fleet
```

```bash
cd shipyard-fleet
```

```bash
npm ci
```

```bash
npm run enroll -- --code enr_…
```

The script checks the machine, redeems the code, installs the member as a service that starts with the machine, and waits until Shipyard shows it online. The machine's browser opens its own dashboard.

### 5. Assign

Back on **Repositories**, choose the fleet member beside each repository. The member starts on it within a cycle, with no restart.

That is all. Write issues.

## A fleet member

A fleet member is Shipyard's engine pool. How it works an issue — the labels, the dependency phrases, the review loop, Project SDLC — is all described in [Shipyard's engine README](design/SHIPYARD.md).

**It holds no GitHub credential.** It asks Shipyard for a token that reaches only its repositories and lasts an hour, and renews it before it runs out. Its commits are the GitHub App's own.

**It keeps itself on Shipyard's commit.** There is no staging: `main` is what runs. Every answer Shipyard gives a member names the commit it runs, and a member on another commit finishes what its agents are doing, fast-forwards its checkout to exactly that commit, and restarts. If it cannot — the checkout has local changes, or is on another branch — it carries on working, and says why on the Fleet page.

**It carries on without Shipyard.** A member that cannot reach the platform keeps working what it was assigned, and reports when the platform is back.

**It measures the machine it runs on.** Every fifteen seconds it reports how busy the processor is (all of it, and its busiest core), the load average, memory in use, how much disk is free where its checkouts are kept, how long Shipyard took to answer it, how late its own process is running, and how long the machine has been up. Each member's heading on the dashboard reads as many of these as it has room for, most telling first, in columns the whole fleet shares; clicking the heading says all of them, and so does the Fleet page. A reading is in trim until it is the thing to look at, then yellow, then red. Nothing is installed to measure it: it is what Node has on every system a member runs on, so Windows, which keeps no load average, reports none. A member that is away says nothing of its machine.

| | |
| --- | --- |
| Its enrollment and token | `~/.shipyard/` (`SHIPYARD_HOME`) |
| Its log | `~/.shipyard/fleet.log` (Linux: `journalctl --user -u shipyard-fleet -f`) |
| Its own settings | `~/.shipyard/env.yaml`: the models its engines use, how long a run may take, how much disk to keep free, its dashboard's port. See [`fleet.env.example.yaml`](fleet.env.example.yaml). What it works on is never set here. |
| Its checkouts and scratch | `~/.shipyard/` |
| Run it by hand | `npm run fleet` |
| Enroll it again | `npm run enroll -- --code <a new code>`: it stays the member it was, with its name and its repositories |
| Retire it | **Fleet → Retire**. Its token stops working at once and the machine stops. |

How many cylinders a member has — how many pieces of work it runs at once — is the member's own number. It is six to begin with and is set on the Fleet page, member by member; the machine does not set it. The member restarts between runs to take a new one.

## How it is run

There is no staging. **Every push to `main` deploys**: [`deploy.yml`](.github/workflows/deploy.yml) type-checks, runs the tests, builds the function and the console, applies `infra/`, and then checks that the platform reports the commit it just deployed. Every fleet member then brings itself to that commit.

The platform is serverless, and one Terraform root:

| | |
| --- | --- |
| The console | a static build in S3 behind CloudFront at `shipyard.outright.io`, with its own sign-in pages at `auth.shipyard.outright.io` |
| The platform | one Lambda, behind an HTTP API (the console, the fleet, GitHub's webhooks) and a WebSocket API at `ws.shipyard.outright.io` (the push channel) |
| Its state | one DynamoDB table |
| Sign-in | a Cognito user pool nobody can sign up to |
| The GitHub App's key | SSM, written when you connect GitHub; never in the table or the repository |

Three Terraform roots, all in the studio's shared state bucket:

| Root | State key | Applied by | Owns |
| --- | --- | --- | --- |
| [`infra/`](infra/main.tf) | `shipyard` | the Deploy workflow | the platform |
| [`infra/bootstrap/`](infra/bootstrap/main.tf) | `shipyard-bootstrap` | a person, once | the role GitHub Actions deploys as, through OIDC. No AWS key is stored anywhere. |
| [`infra/github/`](infra/github/main.tf) | `shipyard-github` | a person, once | this repository's settings, and the two Actions secrets the deploy reads |

This repository is public, so nothing that identifies the account or the operator is in it: the operator's address and the deploy role's ARN are Actions secrets, masked in the workflow's log, and the account's id is read from the caller's identity rather than written down.

## Where things are

| | |
| --- | --- |
| `src/platform/` | the function: the fleet, the repositories, the GitHub App, the relay of every member's events |
| `src/fleet/` | a fleet member: enrolling, the service, the line to Shipyard, keeping itself up to date |
| `src/dashboard/` | the dashboard (Shipyard's field and inbox) and, in `console/`, the console around it |
| `src/shared/` | what the platform, the fleet and the console all read: the protocol between them |
| `src/*.ts` | Shipyard's engine, as it is upstream but for a few seams |
| `console/` | the sign-in pages, and the console's entry page |
| `infra/` | the three Terraform roots |
| `design/` | how Shipyard works, and how its dashboard is built |

## Working on it

```bash
npm ci
```

```bash
npm run build
```

```bash
npm test
```

**The console, with a made-up fleet** — no platform, no sign-in: one member burning, one held by its usage limit, one offline, and a repository assigned to no one, so every heading, notice and page has something to show.

```bash
npm run demo:console
```

**The dashboard alone**, fed the events a real run emits:

```bash
npm run demo:dashboard
```

**The platform on a local port**, with its table in memory, is `startLocalPlatform` in `src/platform/local.ts`. The fleet member's tests run a real member against it, over real HTTP and a real socket.

**Run by hand**, on one machine from an `env.yaml`, using `npm run dev`: [how the engine works](design/SHIPYARD.md).

The engine under `src/*.ts` is kept close to the `shipyard` upstream remote on purpose, so its improvements still merge.
