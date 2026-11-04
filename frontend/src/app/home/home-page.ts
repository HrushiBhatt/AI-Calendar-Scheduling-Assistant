import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { Brew } from '../core/brew';
import { Schedule } from '../core/schedule';
import { formatClock, plural } from '../core/time';
import { wallTime } from '../core/zoned';
import { Icon } from '../shared/icon';

/** The landing page: a greeting and one door to each part of the app. */
@Component({
  selector: 'app-home-page',
  imports: [Icon, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="greeting glass thin">{{ greeting() }}</h1>
    <nav class="doors" aria-label="Go to">
      <a class="card door" routerLink="/calendar">
        <span class="mark"><app-icon name="calendar" /></span>
        <b>Calendar</b>
        <span class="line">{{ calendarLine() }}</span>
      </a>
      <a class="card door" routerLink="/focus">
        <span class="mark"><app-icon name="mug" /></span>
        <b>Focus</b>
        <span class="line">{{ focusLine() }}</span>
      </a>
      <a class="card door" routerLink="/progress">
        <span class="mark"><app-icon name="chart" /></span>
        <b>Progress</b>
        <span class="line">{{ progressLine() }}</span>
      </a>
    </nav>
  `,
  styles: `
    :host {
      display: grid;
      justify-items: center;
      gap: 26px;
      max-width: 980px;
      margin: 6vh auto 0;
    }
    .greeting {
      padding: 12px 26px;
      font-size: clamp(1.25rem, 3vw, 1.75rem);
      font-weight: 600;
      letter-spacing: -0.01em;
      text-align: center;
      border-radius: 99px;
      animation: rise 0.55s var(--ease-out) both;
    }
    .doors {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      width: 100%;
    }
    .door {
      display: grid;
      justify-items: center;
      gap: 8px;
      padding: 34px 20px 30px;
      color: inherit;
      text-align: center;
      text-decoration: none;
      transition: transform 0.4s var(--ease-spring), box-shadow 0.3s, border-color 0.3s;
      animation: rise 0.6s var(--ease-out) both;
    }
    .door:nth-child(2) {
      animation-delay: 80ms;
    }
    .door:nth-child(3) {
      animation-delay: 160ms;
    }
    .door:hover,
    .door:focus-visible {
      border-color: var(--accent);
      box-shadow: inset 0 1px 0 var(--glass-shine), 0 24px 60px var(--glass-shadow), 0 0 40px var(--accent-soft);
      transform: translateY(-6px);
    }
    .mark {
      display: grid;
      place-items: center;
      width: 62px;
      height: 62px;
      margin-bottom: 8px;
      --icon: 28px;
      color: var(--accent-ink);
      background: var(--grad);
      border-radius: 20px;
      box-shadow: 0 8px 24px var(--accent-soft);
      transition: transform 0.4s var(--ease-spring);
    }
    .door:hover .mark {
      transform: scale(1.08) rotate(-4deg);
    }
    b {
      font-size: 1.15rem;
      font-weight: 600;
    }
    .line {
      font-size: 0.85rem;
      color: var(--text-2);
    }
    @media (max-width: 700px) {
      :host {
        margin-top: 2vh;
      }
      .doors {
        grid-template-columns: minmax(0, 1fr);
      }
      .door {
        grid-template-columns: auto minmax(0, 1fr);
        justify-items: start;
        align-items: center;
        gap: 2px 14px;
        padding: 16px;
        text-align: left;
      }
      .mark {
        grid-row: span 2;
        width: 48px;
        height: 48px;
        margin: 0;
        border-radius: 15px;
      }
    }
  `,
})
export class HomePage {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private readonly schedule = inject(Schedule);
  private readonly brew = inject(Brew);

  /** Today alone, whatever range the calendar is showing. */
  private readonly todayPlan = resource({
    params: () => this.schedule.today() || undefined,
    loader: ({ params }) => this.api.schedule(params),
  });

  protected readonly greeting = computed(() => {
    const zone = this.schedule.zone();
    const hour = zone ? wallTime(this.schedule.now(), zone).hour : new Date().getHours();
    const part = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const name = this.auth.user()?.name;
    return name ? `${part}, ${name}` : part;
  });

  protected readonly calendarLine = computed(() => {
    const day = this.todayPlan.hasValue() ? this.todayPlan.value() : null;
    if (!day) return 'Today';
    const meetings = day.events.filter((e) => !e.all_day).length;
    const blocks = day.blocks.filter((b) => b.status === 'accepted').length;
    if (!meetings && !blocks) return 'Nothing today';
    return [meetings && plural(meetings, 'meeting'), blocks && plural(blocks, 'block')].filter(Boolean).join(' · ');
  });

  protected readonly focusLine = computed(() => {
    if (this.brew.timer.state().status !== 'idle') return `${formatClock(this.brew.display().remainingMs / 1000)} left`;
    const m = this.brew.mode();
    return `${m.name} ${m.focus}/${m.rest}`;
  });

  protected readonly progressLine = computed(() => {
    const stats = this.brew.stats();
    if (!stats) return 'Streaks and history';
    return stats.streak ? `${plural(stats.streak, 'day')} streak` : plural(stats.today.sessions, 'session') + ' today';
  });
}
