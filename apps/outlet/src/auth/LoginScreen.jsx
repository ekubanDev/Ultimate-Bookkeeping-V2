import { useState } from "react";
import { Button, Input } from "@ub/shared-ui";
import { useAuth } from "./AuthContext.jsx";

/**
 * LoginScreen — minimal email/password sign-in form, rendered by App.jsx
 * when auth status is 'signed_out'.
 *
 * Owns: the form's own field/submitting/error state.
 * Does NOT own: what "signed in" means afterwards — signIn() triggers
 * Firebase's onAuthStateChanged, which AuthProvider picks up and drives the
 * status transition; this component doesn't navigate or set global state
 * itself.
 */
export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err?.message || "Sign-in failed. Check your email and password.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="ub-login-screen">
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit}>
        <Input
          label="Email"
          id="login-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
        <Input
          label="Password"
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        {error ? (
          <p role="alert" className="ub-login-screen__error">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </section>
  );
}
