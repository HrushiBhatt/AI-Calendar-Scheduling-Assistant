import { Injectable } from '@angular/core';

/** planner.Plan's output, as JSON from Go. */
export interface PlannerBlock {
  task_id: number | null;
  task: string;
  starts_at: string;
  focus_min: number;
  rest_min: number;
  mode: string;
  score: number;
  explain: string;
}

export interface PlannerResult {
  blocks: PlannerBlock[] | null;
  unplaced: { task_id: number | null; task: string; wanted: number; placed: number; reason: string }[] | null;
  notes: string[] | null;
}

/** planner.Check's output. An empty code means the slot is fine. */
export interface PlannerViolation {
  code: string;
  at?: string;
  end?: string;
}

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

interface PlannerGlobals {
  Go?: new () => GoRuntime;
  brewFocusPlan?: (input: string) => string;
  brewFocusCheck?: (request: string) => string;
}

const globals = globalThis as unknown as PlannerGlobals;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; // relative, so it follows the page's <base href>
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.append(script);
  });
}

/**
 * The real Go scheduler (backend/cmd/plannerwasm), compiled to WebAssembly. It's loaded on
 * the first planning request, because it's the largest file the demo has.
 */
@Injectable({ providedIn: 'root' })
export class LocalPlanner {
  private loading?: Promise<void>;

  private load(): Promise<void> {
    this.loading ??= (async () => {
      await loadScript('wasm_exec.js');
      if (!globals.Go) throw new Error('the Go runtime did not load');
      const go = new globals.Go();
      const response = await fetch(new URL('planner.wasm', document.baseURI).href);
      if (!response.ok) throw new Error(`planner.wasm answered ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
      void go.run(instance); // never settles: main() blocks to keep the functions callable
      for (let i = 0; i < 100 && !globals.brewFocusPlan; i++) await new Promise((r) => setTimeout(r, 10));
      if (!globals.brewFocusPlan) throw new Error('the scheduler did not start');
    })().catch((err: unknown) => {
      this.loading = undefined; // let the next request try again
      throw err;
    });
    return this.loading;
  }

  async plan(input: unknown): Promise<PlannerResult> {
    await this.load();
    return parse<PlannerResult>(globals.brewFocusPlan!(JSON.stringify(input)));
  }

  async check(input: unknown, start: string, mode: unknown): Promise<PlannerViolation> {
    await this.load();
    return parse<PlannerViolation>(globals.brewFocusCheck!(JSON.stringify({ input, start, mode })));
  }
}

function parse<T>(json: string): T {
  const out = JSON.parse(json) as T & { error?: string };
  if (out.error) throw new Error(out.error);
  return out;
}
