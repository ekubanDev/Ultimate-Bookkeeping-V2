/**
 * formatMoney — render a NUMERIC(12,2) wire string for display.
 *
 * THIS NEVER PARSES THE VALUE AS A NUMBER. Money crosses the wire as a
 * string precisely so it never touches a float (CLAUDE.md, "Non-negotiable
 * constraints"), and `parseFloat("1234.50").toFixed(2)` would round-trip
 * through a binary double for no reason at all. Grouping the thousands is a
 * string operation on the digits, so the digits that arrive are the digits
 * that render — always, including values a double cannot hold exactly.
 *
 * Input is what the API sends: "45.00", "1234.50", "-12.00", "0.00".
 * Output is "₵45.00", "₵1,234.50", "-₵12.00", "₵0.00".
 *
 * The minus sign goes OUTSIDE the symbol ("-₵12.00", not "₵-12.00") because
 * that is how a refund or a negative adjustment reads at a glance.
 *
 * Anything unrecognizable is returned unchanged rather than coerced to
 * "₵0.00" — showing a wrong amount of money is worse than showing something
 * obviously odd, and a silent zero is indistinguishable from a real one.
 */

const GHANA_CEDI = "₵"; // ₵

/** Insert thousands separators into a run of digits, right to left. */
function groupDigits(digits) {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

export function formatMoney(value, { symbol = GHANA_CEDI } = {}) {
  if (typeof value !== "string") {
    // Numbers are not accepted on purpose: taking one here would quietly
    // legitimise a float somewhere upstream. Render what we were given.
    return value == null ? "" : String(value);
  }

  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return trimmed;

  const [, sign, whole, fraction = ""] = match;
  const cents = (fraction + "00").slice(0, 2);
  return `${sign}${symbol}${groupDigits(whole)}.${cents}`;
}

export { GHANA_CEDI };
