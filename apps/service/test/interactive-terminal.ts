export function interactiveTerminalEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete environment.CI;
  delete environment.CONTINUOUS_INTEGRATION;
  return environment;
}
