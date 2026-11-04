import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Insights, Rate } from '../core/models';

/** The planning numbers: does scheduling help, and how well does the planner guess? */
@Component({
  selector: 'app-planning-insights',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let i = insights();
    <div class="compare">
      <div class="bar-row">
        <span class="label">Planned finished</span>
        <span class="track"><i [style.width.%]="width(i.completion.planned)"></i></span>
        <span class="big">{{ pct(i.completion.planned) }}</span>
      </div>
      <div class="bar-row">
        <span class="label">Unplanned finished</span>
        <span class="track other"><i [style.width.%]="width(i.completion.ad_hoc)"></i></span>
        <span class="big">{{ pct(i.completion.ad_hoc) }}</span>
      </div>
    </div>
    @if (verdict(); as v) {
      <p class="verdict">{{ v }}</p>
    }
    <dl class="grid">
      <div [title]="frac(i.acceptance)"><dt>Accepted</dt><dd>{{ pct(i.acceptance) }}</dd></div>
      <div [title]="frac(i.partial_accept)"><dt>Partly accepted</dt><dd>{{ pct(i.partial_accept) }}</dd></div>
      <div [title]="frac(i.conflicts)"><dt>Hit by a change</dt><dd>{{ pct(i.conflicts) }}</dd></div>
      <div [title]="frac(i.estimate_accuracy.within_one)"><dt>Estimates within 1</dt><dd>{{ pct(i.estimate_accuracy.within_one) }}</dd></div>
      @if (i.assistant.turns) {
        <div [title]="frac(i.tool_call_validity)"><dt>Valid Claude calls</dt><dd>{{ pct(i.tool_call_validity) }}</dd></div>
      }
      @if (i.scheduler_latency.samples) {
        <div [title]="'p99 ' + ms(i.scheduler_latency.p99_us)"><dt>Scheduler, median</dt><dd>{{ ms(i.scheduler_latency.p50_us) }}</dd></div>
      }
    </dl>
  `,
  styles: `
    .compare {
      display: grid;
      gap: 10px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr) 52px;
      align-items: center;
      gap: 12px;
    }
    .label,
    dt {
      font-size: 0.78rem;
      color: var(--text-2);
    }
    .track {
      height: 8px;
      overflow: hidden;
      background: var(--surface-3);
      border-radius: 99px;
    }
    .track i {
      display: block;
      height: 100%;
      background: var(--accent);
      border-radius: 99px;
      animation: grow 1s var(--ease-out) both;
    }
    .other i {
      background: var(--meeting);
    }
    .big {
      font-size: 1rem;
      font-weight: 600;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .verdict {
      margin-top: 12px;
      font-size: 0.82rem;
      color: var(--text-2);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 8px;
      margin-top: 16px;
    }
    .grid div {
      display: grid;
      gap: 3px;
      padding: 10px 12px;
      background: var(--surface-2);
      border-radius: var(--radius-sm);
    }
    dd {
      font-size: 1rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    @keyframes grow {
      from { width: 0; }
    }
  `,
})
export class PlanningInsights {
  readonly insights = input.required<Insights>();

  protected readonly verdict = computed(() => {
    const { planned, ad_hoc } = this.insights().completion;
    if (planned.of < 5 || ad_hoc.of < 5 || planned.rate === null || ad_hoc.rate === null) return '';
    const diff = Math.round((planned.rate - ad_hoc.rate) * 100);
    if (Math.abs(diff) < 5) return 'Planning makes little difference so far.';
    return diff > 0 ? `You finish ${diff} points more when you plan.` : `You finish ${-diff} points less when you plan.`;
  });

  protected width(r: Rate): number {
    return r.rate === null ? 0 : Math.round(r.rate * 100);
  }

  protected pct(r: Rate): string {
    return r.rate === null ? '–' : `${Math.round(r.rate * 100)}%`;
  }

  protected frac(r: Rate): string {
    return r.of ? `${r.count} of ${r.of}` : 'None yet';
  }

  protected ms(us: number): string {
    return us < 1000 ? `${us} µs` : `${(us / 1000).toFixed(1)} ms`;
  }
}
