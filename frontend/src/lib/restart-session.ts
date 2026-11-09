export async function restartSession(
  id: string,
  operations: {
    disconnect: (id: string, terminate: boolean) => Promise<void>;
    remove: (id: string) => Promise<void>;
    start: () => Promise<void>;
    refresh: () => Promise<void>;
  },
): Promise<void> {
  await operations.disconnect(id, true);
  await operations.remove(id);
  try {
    await operations.start();
  } finally {
    await operations.refresh();
  }
}
