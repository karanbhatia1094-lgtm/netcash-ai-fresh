export default function LegalDataRetentionPage() {
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h1>Data Retention Policy</h1>
        <p>Default retention windows are applied per data class: orders/attribution analytics, queue logs, and sync telemetry.</p>
        <p>Retention can be constrained per shop contract or legal requirement.</p>
        <p>Deletion requests are processed per shop tenant identity.</p>
      </div>
    </div>
  );
}
