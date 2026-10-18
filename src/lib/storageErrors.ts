/** Error names are safe to display; messages may contain private data. */
export function storageErrorCode(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  return name && ['QuotaExceededError', 'SecurityError', 'InvalidStateError', 'VersionError', 'AbortError', 'TimeoutError', 'UnknownError', 'StorageSchemaError', 'StorageBlockedError'].includes(name)
    ? name : 'StorageUnavailable';
}
