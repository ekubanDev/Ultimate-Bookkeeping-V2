import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ExpensesScreen from "./ExpensesScreen.jsx";

// Side-effecting boundary: mock the expense submission hook.
const submitExpenseMock = vi.fn();
vi.mock("./useSubmitExpense.js", () => ({
  useSubmitExpense: () => ({
    submitExpense: (...args) => submitExpenseMock(...args),
    status: "idle",
    error: null,
  }),
}));

// Auth boundary: signed-in outlet manager.
vi.mock("../../auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    profile: {
      id: "user-1",
      role: "outlet_manager",
      outlet_id: "outlet-test-1",
      display_name: "Test Manager",
    },
    status: "signed_in",
  }),
}));

beforeEach(() => {
  submitExpenseMock.mockReset();
  submitExpenseMock.mockResolvedValue({ state: "queued", client_id: "mock-entry" });
});

describe("ExpensesScreen + ExpenseForm", () => {
  it("renders the expense form with amount, category, and note fields", () => {
    render(<ExpensesScreen />);
    expect(screen.getByLabelText(/amount/i)).toBeTruthy();
    expect(screen.getByLabelText(/category/i)).toBeTruthy();
    expect(screen.getByLabelText(/note/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /add expense/i })).toBeTruthy();
  });

  it("shows a validation error when amount is empty", async () => {
    render(<ExpensesScreen />);

    // Fill category but leave amount blank.
    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "transport" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add expense/i }));

    expect(await screen.findByText(/enter a valid amount/i)).toBeTruthy();
    expect(submitExpenseMock).not.toHaveBeenCalled();
  });

  it("shows a validation error when amount is not a valid NUMERIC(12,2) string", async () => {
    render(<ExpensesScreen />);

    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "not-a-number" },
    });
    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "utilities" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add expense/i }));

    expect(await screen.findByText(/enter a valid amount/i)).toBeTruthy();
    expect(submitExpenseMock).not.toHaveBeenCalled();
  });

  it("shows a validation error when category is empty", async () => {
    render(<ExpensesScreen />);

    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "50.00" },
    });
    // Leave category blank.
    fireEvent.click(screen.getByRole("button", { name: /add expense/i }));

    expect(await screen.findByText(/category is required/i)).toBeTruthy();
    expect(submitExpenseMock).not.toHaveBeenCalled();
  });

  it("calls submitExpense with correctly trimmed values on a valid submit", async () => {
    render(<ExpensesScreen />);

    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "75.50" },
    });
    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "  supplies  " },
    });
    fireEvent.change(screen.getByLabelText(/note/i), {
      target: { value: "cleaning products" },
    });

    fireEvent.click(screen.getByRole("button", { name: /add expense/i }));

    await vi.waitFor(() => expect(submitExpenseMock).toHaveBeenCalledTimes(1));

    const [call] = submitExpenseMock.mock.calls;
    expect(call[0].outletId).toBe("outlet-test-1");
    expect(call[0].amount).toBe("75.50");
    expect(call[0].category).toBe("supplies"); // trimmed
    expect(call[0].note).toBe("cleaning products");
  });

  it("does not call submitExpense when amount has more than 2 decimal places", async () => {
    render(<ExpensesScreen />);

    fireEvent.change(screen.getByLabelText(/amount/i), {
      target: { value: "50.123" },
    });
    fireEvent.change(screen.getByLabelText(/category/i), {
      target: { value: "fuel" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add expense/i }));

    expect(await screen.findByText(/enter a valid amount/i)).toBeTruthy();
    expect(submitExpenseMock).not.toHaveBeenCalled();
  });

  it("accepts a whole-number amount with no decimal part", async () => {
    render(<ExpensesScreen />);

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: "rent" } });
    fireEvent.click(screen.getByRole("button", { name: /add expense/i }));

    await vi.waitFor(() => expect(submitExpenseMock).toHaveBeenCalledTimes(1));
    expect(submitExpenseMock.mock.calls[0][0].amount).toBe("100");
  });
});
