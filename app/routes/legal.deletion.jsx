export default function LegalDeletionFlowPage() {
  return (
    <div className="nc-shell">
      <div className="nc-card nc-section">
        <h1>Data Deletion Flow</h1>
        <p>Deletion is processed per shop via merchant request or uninstall event.</p>
        <p>Flow includes connector credential removal, tenant analytics deletion, and queue cleanup for that shop.</p>
        <p>Support receives a deletion completion timestamp for audit records.</p>
      </div>
    </div>
  );
}
