import { useAuth } from "../../auth/AuthContext.jsx";
import ExpenseForm from "./ExpenseForm.jsx";
import { useSubmitExpense } from "./useSubmitExpense.js";

/**
 * ExpensesScreen — top-level expenses screen.
 *
 * Owns: layout and screen-level state (outlet_id — read from the signed-in
 * manager's /me profile, per api-contracts.md §1).
 * Does NOT own: form field state (ExpenseForm) or submission wiring
 * (delegates to useSubmitExpense).
 */
export default function ExpensesScreen() {
  const { profile } = useAuth();
  const { submitExpense, status } = useSubmitExpense();

  // Admin accounts have no outlet_id — this app is for outlet managers only
  // (the admin console at /apps/admin is where cross-outlet views live, per
  // CLAUDE.md's scope boundary). Surface a plain notice rather than ever
  // sending a null outlet_id to the backend.
  if (!profile?.outlet_id) {
    return (
      <section className="ub-expenses-screen">
        <h1>Expenses</h1>
        <p>This app is for outlet managers. Your account has no outlet assigned.</p>
      </section>
    );
  }

  const handleSubmit = async (values) => {
    await submitExpense({
      outletId: profile.outlet_id,
      amount: values.amount,
      category: values.category,
      note: values.note,
    });
  };

  return (
    <section className="ub-expenses-screen">
      <h1>Expenses</h1>
      <ExpenseForm onSubmit={handleSubmit} status={status} />
    </section>
  );
}
