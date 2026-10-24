import { sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';
import { renderSql } from '../../test/helpers.js';
import { firstSegmentJoin } from '../sessions/groupedPlays.js';

const text = (fragment: Parameters<typeof renderSql>[0]) =>
  renderSql(fragment).sql.replace(/\s+/g, ' ').trim();

const from = new Date('2026-09-01T00:00:00Z');
const to = new Date('2026-10-01T00:00:00Z');
const window = [sql`s.started_at >= ${from}`, sql`s.started_at < ${to}`];

describe('firstSegmentJoin', () => {
  it("renders GET /sessions' join: alias gs, bounds from grouped_sessions, the window after", () => {
    expect(text(firstSegmentJoin({ alias: 'gs', boundsFrom: 'grouped_sessions' }, window))).toBe(
      'JOIN sessions s ON s.id = gs.first_session_id AND s.started_at = gs.started_at' +
        ' AND s.started_at >= (SELECT MIN(started_at) FROM grouped_sessions)' +
        ' AND s.started_at <= (SELECT MAX(started_at) FROM grouped_sessions)' +
        ' AND s.started_at >= $1 AND s.started_at < $2'
    );
  });

  it("renders history's join: bounds from history_page_ids", () => {
    expect(text(firstSegmentJoin({ alias: 'gs', boundsFrom: 'history_page_ids' }, []))).toBe(
      'JOIN sessions s ON s.id = gs.first_session_id AND s.started_at = gs.started_at' +
        ' AND s.started_at >= (SELECT MIN(started_at) FROM history_page_ids)' +
        ' AND s.started_at <= (SELECT MAX(started_at) FROM history_page_ids)'
    );
  });

  it('renders the v2 page join on chain_started_at', () => {
    expect(
      text(
        firstSegmentJoin({ alias: 'p', boundsFrom: 'page', startColumn: 'chain_started_at' }, [])
      )
    ).toBe(
      'JOIN sessions s ON s.id = p.first_session_id AND s.started_at = p.chain_started_at' +
        ' AND s.started_at >= (SELECT MIN(chain_started_at) FROM page)' +
        ' AND s.started_at <= (SELECT MAX(chain_started_at) FROM page)'
    );
  });
});
