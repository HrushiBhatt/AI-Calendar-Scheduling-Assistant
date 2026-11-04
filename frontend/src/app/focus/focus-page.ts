import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Brew } from '../core/brew';
import { TaskList } from '../tasks/task-list';
import { AmbienceMixer } from './ambience-mixer';
import { ModePicker } from './mode-picker';
import { TimerStage } from './timer-stage';

/** The timer, centered. Everything around it recedes while a focus block runs. */
@Component({
  selector: 'app-focus-page',
  imports: [TimerStage, TaskList, ModePicker, AmbienceMixer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="layout" [class.focusing]="focusing()">
      <app-timer-stage class="stage" />
      <div class="side tasks"><app-task-list /></div>
      <div class="side tools">
        <app-mode-picker />
        <app-ambience-mixer />
      </div>
    </div>
  `,
  styles: `
    /* The stage comes first in the DOM (and on phones); grid areas place the panels. */
    .layout {
      display: grid;
      gap: 16px;
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'stage' 'tasks' 'tools';
      max-width: 1240px;
      margin-inline: auto;
    }
    .stage { grid-area: stage; }
    .tasks { grid-area: tasks; }
    .tools { grid-area: tools; }
    .side {
      display: grid;
      gap: 14px;
      align-content: start;
    }
    @media (min-width: 860px) {
      .layout {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-template-areas: 'stage stage' 'tasks tools';
        align-items: start;
      }
    }
    @media (min-width: 1240px) {
      .layout {
        grid-template-columns: 300px minmax(0, 1fr) 300px;
        grid-template-areas: 'tasks stage tools';
      }
    }
  `,
  host: { '(window:keydown)': 'brew.onKey($event)' },
})
export class FocusPage {
  protected readonly brew = inject(Brew);
  protected readonly focusing = computed(() => {
    const { status, phase } = this.brew.timer.state();
    return status === 'running' && phase === 'focus';
  });
}
