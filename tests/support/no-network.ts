// Test guard: no test may reach the real network. Provider code takes an
// injected fetch; anything that falls through to the global one fails loudly.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`Unmocked network request in a test: ${url}`);
}) as typeof fetch;
