import { Pipe, PipeTransform } from '@angular/core';
import { formatMinutes, plural } from '../core/state/time';

/** 135 → "2h 15m" */
@Pipe({ name: 'minutes' })
export class MinutesPipe implements PipeTransform {
  transform(minutes: number): string {
    return formatMinutes(minutes);
  }
}

/** 3 | plural: 'brew' → "3 brews" */
@Pipe({ name: 'plural' })
export class PluralPipe implements PipeTransform {
  transform(n: number, word: string): string {
    return plural(n, word);
  }
}
