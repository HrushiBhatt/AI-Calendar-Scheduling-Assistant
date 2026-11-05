import type { Environment } from './types';

/** The normal build: the Go server is the backend, and you sign in. */
export const environment: Environment = {
  browserBackend: false,
  interceptors: [],
};
