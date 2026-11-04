import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Insights, Rate } from '../core/models';

/** The planning numbers: does scheduling help, and how well does the planner guess? */
@Component({
  selector: 'app-planning-insights',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let i = insights();
    <div class="headline">
      <div class="side">
        <span class="label">Planned blocks finished</span>
        <span class="big">{{ pct(i.completion.planned) }}</span>
        <span class="sub">{{ frac(i.completion.planned) }}</span>
      </div>
      <span class="vs" aria-hidden="true">vs</span>
      <div class="side">
        <span class="label">Unplanned blocks finished</span>
        <span class="big">{{ pct(i.completion.ad_hoc) }}</span>
        <span class="sub">{{ frac(i.completion.ad_hoc) }}</span>
      </div>
    </div>
    <p class="verdict">{{ verdict() }}</p>
    <dl class="grid">
      <div><dt>Proposed blocks accepted</dt><dd>{{ pct(i.acceptance) }} <small>{{ frac(i.acceptance) }}</small></dd></div>
      <div><dt>Plans accepted only in part</dt><dd>{{ pct(i.partial_accept) }} <small>{{ frac(i.partial_accept) }}</small></dd></div>
      <div><dt>Accepted blocks hit by a calendar change</dt><dd>{{ pct(i.conflicts) }} <small>{{ frac(i.conflicts) }}</small></dd></div>
      <div><dt>Finished tasks within one brew of the estimate</dt><dd>{{ pct(i.estimate_accuracy.within_one) }} <small>{{ frac(i.estimate_accuracy.within_one) }}</small></dd></div>
      @if (i.assistant.turns) {
        <div><dt>Assistant tool calls with valid arguments</dt><dd>{{ pct(i.tool_call_validity) }} <small>{{ frac(i.tool_call_validity) }}</small></dd></div>
      }
      @if (i.scheduler_latency.samples) {
        <div><dt>Scheduler time, median</dt><dd>{{ ms(i.scheduler_latency.p50_us) }} <small>p99 {{ ms(i.scheduler_latency.p99_us) }}</small></dd></div>
      }
    </dl>
  `,
  styles: `
    .headline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px 24px;
    }
    .side {
      display: grid;
      gap: 4px;
    }
    .label,
    dt {
      font-size: 0.7rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--gray-400);
    }
    .big {
      font-family: var(--font-pixel);
      font-size: 1.1rem;
      color: var(--accent-bright);
    }
    .sub,
    small {
      font-size: 0.72rem;
      color: var(--gray-500);
    }
    .vs {
      font-family: var(--font-pixel);
      font-size: 0.5rem;
      color: var(--gray-500);
    }
    .verdict {
      margin: 12px 0 16px;
      font-size: 0.85rem;
      color: var(--gray-300);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }
    .grid div {
      display: grid;
      gap: 4px;
      padding: 10px 12px;
      background: var(--gray-850);
    }
    dd {
      font-family: var(--font-pixel);
      font-size: 0.7rem;
      color: var(--cream-light);
    }
  `,
})
export class PlanningInsights {
  readonly insights = input.required<Insights>();

  protected readonly verdict = computed(() => {
    const { planned, ad_hoc } = this.insights().completion;
    if (planned.of < 5 || ad_hoc.of < 5 || planned.rate === null || ad_hoc.rate === null) {
      return 'Too few sessions on one side to compare yet. Plan a week and come back.';
    }
    const diff = Math.round((planned.rate - ad_hoc.rate) * 100);
    if (Math.abs(diff) < 5) return 'So far, planning makes little difference to whether you finish a block.';
    return diff > 0
      ? `You finish ${diff} points more of the blocks you plan ahead.`
      : `You finish ${-diff} points fewer of your planned blocks. They may be landing at the wrong times.`;
  });

  protected pct(r: Rate): string {
    return r.rate === null ? '–' : `${Math.round(r.rate * 100)}%`;
  }

  protected frac(r: Rate): string {
    return r.of ? `${r.count} of ${r.of}` : 'none yet';
  }

  protected ms(us: number): string {
    return us < 1000 ? `${us} µs` : `${(us / 1000).toFixed(1)} ms`;
  }
}
