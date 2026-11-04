import { TestBed } from '@angular/core/testing';
import { CAFE } from './sprites';
import { Sprite, runs } from './sprite';

describe('Sprite', () => {
  it('merges same-colored neighbours into one rect per run', () => {
    expect(runs(['xx.x', '....'], { x: 'red' })).toEqual([
      { x: 0, y: 0, w: 2, fill: 'red' },
      { x: 3, y: 0, w: 1, fill: 'red' },
    ]);
  });

  it('paints a silhouette when given a fill', () => {
    expect(runs(['ab'], { a: 'red', b: 'blue' }, '#222').map((r) => r.fill)).toEqual(['#222']);
  });

  it('renders every café item as crisp SVG', async () => {
    const fixture = TestBed.createComponent(Sprite);
    for (const item of CAFE) {
      fixture.componentRef.setInput('rows', item.rows);
      fixture.componentRef.setInput('palette', item.palette);
      await fixture.whenStable();
      const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
      expect(svg.getAttribute('viewBox')).toBe('0 0 12 12');
      expect(svg.querySelectorAll('rect').length).toBeGreaterThan(5);
    }
  });
});
