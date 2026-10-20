import type { WorkItemService } from '../company/workItems/workItemService.js';

const workItemServices = new Map<string, WorkItemService>();

export function registerWorkItemService(namespaceDir: string, service: WorkItemService): () => void {
  workItemServices.set(namespaceDir, service);
  return () => {
    if (workItemServices.get(namespaceDir) === service) workItemServices.delete(namespaceDir);
  };
}

export function registeredWorkItemServices(): readonly WorkItemService[] {
  return [...workItemServices.values()];
}
