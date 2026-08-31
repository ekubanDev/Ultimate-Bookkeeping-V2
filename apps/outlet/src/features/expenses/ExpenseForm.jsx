import { useState } from "react";
import { Button, Input } from "@ub/shared-ui";

/**
 * ExpenseForm — collects amount/category/note for a new expense entry.
 *
 * Owns: form field state and validation-before-submit.
 * Does NOT own: submission (calls `onSubmit(values)`, which ExpensesScreen
 * wires to useSubmitExpense.submitExpense) or outlet context.
 */
export default function ExpenseForm({ onSubmit, status = "idle" }) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit?.({ amount, category, note });
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
      <Input
        label="Category"
        id="expense-category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      />
      <Input
        label="Note"
        id="expense-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button type="submit" disabled={status === "queued"}>
        {status === "queued" ? "Recording..." : "Add expense"}
      </Button>
    </form>
  );
}
