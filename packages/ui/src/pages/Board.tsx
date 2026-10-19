/** Board (§13.1). M0 renders the empty state; runs arrive with M6. */
export function BoardPage() {
  return (
    <div className="card">
      <div className="empty">No runs yet. Assign a ticket to Mates in Jira to start one.</div>
    </div>
  );
}
