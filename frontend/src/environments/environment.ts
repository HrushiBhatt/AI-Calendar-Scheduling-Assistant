import type { Environment } from './types';

/** The normal build: the Go server is the backend. */
export const environment: Environment = {
  browserBackend: false,
  interceptors: [],
};
