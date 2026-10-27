import { call, iap } from '../api.ts';
import { Alert, Empty, formatTime } from '../ui.tsx';
import { useAsync } from '../useAsync.ts';

const describe = (type: string, payload: Record<string, unknown>) => {
  switch (type) {
    case 'project.created':
      return `Created project "${String(payload.name)}"`;
    case 'run.created':
      return `Started ${String(payload.workflow)} run "${String(payload.title)}"`;
    case 'run.transitioned':
      return `Run moved ${String(payload.from)} → ${String(payload.to)}${payload.reason ? `: ${String(payload.reason)}` : ''}`;
    case 'setting.changed':
      return `Setting ${String(payload.key)} changed ${String(payload.from)} → ${String(payload.to)}`;
    case 'schema.migrated':
      return `Database upgraded to schema ${String(payload.to)}`;
    default:
      return type;
  }
};

export function ActivityView({ projectId, projectName }: { projectId: string | null; projectName: string | null }) {
  const { data, error, loading } = useAsync(() => call(iap().listEvents({ projectId: projectId ?? undefined, limit: 200 })), [projectId]);
  return (
    <>
      <h1 className="page-title">Activity</h1>
      <p className="page-lede">
        {projectName ? `Changes to ${projectName}. ` : 'Every change is recorded here. '}The log is append-only: entries cannot be edited or deleted.
      </p>
      <section className="card" aria-labelledby="activity-title">
        <h2 className="card-title" id="activity-title">
          Audit log {data && <span className="count-pill">latest {data.length}</span>}
        </h2>
        {loading && !data && <p className="loading">Loading activity…</p>}
        {error && <Alert tone="danger">{error}</Alert>}
        {data && data.length === 0 && <Empty title="No activity yet" />}
        {data && data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((e) => (
                <tr key={e.seq}>
                  <td className="subtle">{formatTime(e.at)}</td>
                  <td>{e.actor}</td>
                  <td>{describe(e.type, e.payload)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
