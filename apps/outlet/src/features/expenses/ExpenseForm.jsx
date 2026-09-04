import { useState } from "react";
import { Button, Input } from "@ub/shared-ui";

/**
 * ExpenseForm — collects amount/category/note for a new expense entry.
 *
 * Owns: form field state and client-side validation (amount format, category
 * presence). Does NOT own: submission (calls `onSubmit(values)`, which
 * ExpensesScreen wires to useSubmitExpense.submitExpense) or outlet context.
 *
 * Money discipline: amount is validated as a NUMERIC(12,2) string and passed
 * through as-is — never parsed to float (CLAUDE.md money rule).
 */

// Matches the backend's NUMERIC(12,2) wire format — e.g. "50.00", "1234.05".
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export default function ExpenseForm({ onSubmit, status = "idle" }) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  const [amountError, setAmountError] = useState("");
  const [categoryError, setCategoryError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    let valid = true;

    if (!AMOUNT_RE.test(amount.trim())) {
      setAmountError("Enter a valid amount (e.g. 50.00)");
      valid = false;
    } else {
      setAmountError("");
    }

    if (!category.trim()) {
      setCategoryError("Category is required");
      valid = false;
    } else {
      setCategoryError("");
    }

    if (!valid) return;

    try {
      await onSubmit?.({ amount: amount.trim(), category: category.trim(), note: note.trim() });
      // enqueue() resolves fast — reset the form so the manager can record
      // the next expense. The status banner (synced/failed) still renders
      // below the cleared fields; SyncBanner handles persistent failures.
      setAmount("");
      setCategory("");
      setNote("");
    } catch {
      // submitExpense already set status to 'failed'; keep fields populated
      // so the manager can review and retry without re-entering everything.
    }
  };

  return (
    <form className="ub-expense-form" onSubmit={handleSubmit}>
      <Input
        label="Amount"
        id="expense-amount"
        type="text"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      {amountError ? (
        <p className="ub-expense-form__error" role="alert">{amountError}</p>
      ) : null}
      <Input
        label="Category"
        id="expense-category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      />
      {categoryError ? (
        <p className="ub-expense-form__error" role="alert">{categoryError}</p>
      ) : null}
      <Input
        label="Note"
        id="expense-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {status === "synced" ? (
        <p className="ub-expense-form__success" role="status">Expense recorded.</p>
      ) : null}
      {status === "failed" ? (
        <p className="ub-expense-form__error" role="alert">
          Could not record this expense. Try again.
        </p>
      ) : null}
      <Button type="submit" disabled={status === "queued"}>
        {status === "queued" ? "Recording..." : "Add expense"}
      </Button>
    </form>
  );
}
