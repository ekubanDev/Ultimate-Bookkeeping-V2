import ExpenseForm from "./ExpenseForm.jsx";
import { useSubmitExpense } from "./useSubmitExpense.js";

/**
 * ExpensesScreen — top-level expenses screen.
 *
 * Owns: layout and screen-level state.
 * Does NOT own: form field state (ExpenseForm) or submission wiring
 * (delegates to useSubmitExpense).
 */
export default function ExpensesScreen() {
  const { submitExpense, status } = useSubmitExpense();

  const handleSubmit = async (values) => {
    await submitExpense({
      outletId: "TODO-outlet-id",
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
