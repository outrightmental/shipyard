import './styles/global.css';
import './styles/inbox.css';
import './styles/drawer.css';
import './components/shipyard-dashboard.js';
import { DashboardStore } from './store/dashboard-store.js';

const store = new DashboardStore();
await store.bootstrap();
store.connectLive();

const app = document.createElement('shipyard-dashboard') as HTMLElement & { store: DashboardStore };
(app as unknown as Record<string, unknown>)['store'] = store;
document.body.appendChild(app);
