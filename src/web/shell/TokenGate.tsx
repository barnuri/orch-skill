import { useState } from "react";
import type { FormEvent } from "react";
import { setToken } from "../api/token";
import { connection } from "../api/status";
import { queryClient } from "../api/queries";
import { Button } from "../components/Button";

/** Shown whenever the API answers 401. Polling keeps running, so a correct token clears the gate on the next tick. */
export function TokenGate() {
  const [value, setValue] = useState("");
  const onSubmit = (event: FormEvent): void => {
    // Never navigates (the CSP forbids form-action anyway); the token goes to sessionStorage.
    event.preventDefault();
    const token = value.trim();
    if (token === "") {
      return;
    }
    setToken(token);
    connection.clearAuth();
    void queryClient.invalidateQueries();
  };
  return (
    <section className="token-gate">
      <h1>Token required</h1>
      <p className="sub">This dashboard only talks to the server with the bearer token it printed on start.</p>
      <form className="form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="token-input">Token</label>
          <input
            id="token-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the token printed by dispatch.ts ui"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </div>
        <div>
          <Button variant="primary" type="submit">
            Continue
          </Button>
        </div>
      </form>
    </section>
  );
}
