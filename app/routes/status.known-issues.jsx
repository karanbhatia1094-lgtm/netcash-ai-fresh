export default function KnownIssuesPage() {
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h1>Known Issues</h1>
        <ul>
          <li>Connector API upstream limits may delay spend ingestion during peak windows.</li>
          <li>Large backfills can increase queue backlog and temporarily age sync freshness.</li>
          <li>Attribution quality depends on UTM/campaign hygiene from upstream tools.</li>
        </ul>
      </div>
    </div>
  );
}
