import type { AppContext } from "../../app/createAppContext.js";
import { listLocalModelCatalog } from "../../model/ModelCatalog.js";

export function getConfig(app: AppContext) {
  return app.getConfigPayload();
}

export async function modelsCheck(app: AppContext) {
  const entries = app.config.models.clients.map(async (c) => {
    const client = app.clientMap.get(c.name)!;
    const available = await client.isAvailable();
    return { name: c.name, provider: c.provider, location: c.location, model: c.model, available };
  });
  return Promise.all(entries);
}

export async function modelsCatalog(app: AppContext) {
  const entries = await listLocalModelCatalog(app.config.models.clients);
  return { entries };
}

export function metrics(app: AppContext) {
  return { stats: app.metrics.snapshot(), recent: app.metrics.recentCalls().slice(0, 20) };
}
