"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CONSENT_KEY, api } from "@/lib/client";

const POLICY_VERSION = "1.0";

const CHOICES = [
  { key: "activity_recording", text: "I understand that prompts, responses, and activity may be recorded." },
  { key: "cognee_memory_storage", text: "I understand that selected event data may be stored in Cognee for memory and learning analysis." },
  { key: "sensitive_information_acknowledged", text: "I will not enter credentials or sensitive personal information." },
] as const;

function newParticipantId() {
  return `p-${crypto.randomUUID().slice(0, 12)}`;
}

export function ConsentGate({ onAccepted }: { onAccepted: (consentId: string) => void }) {
  const [participantId] = useState(newParticipantId);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const all = CHOICES.every((c) => checked[c.key]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ consent_id: string }>("/api/consent", {
        method: "POST",
        body: JSON.stringify({ policy_version: POLICY_VERSION, participant_id: participantId, choices: checked }),
      });
      localStorage.setItem(CONSENT_KEY, r.consent_id);
      onAccepted(r.consent_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh grid place-items-center bg-muted/40 p-4">
      <section aria-labelledby="consent-title" className="w-full max-w-xl rounded-2xl border bg-background p-8 shadow-sm">
        <p className="text-sm font-medium tracking-wide text-muted-foreground">RecallLens · Your world, remembered.</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 id="consent-title" className="text-2xl font-semibold">Personal Agent Data Policy</h1>
          <Badge variant="outline" className="text-sm">Version {POLICY_VERSION}</Badge>
        </div>

        <dl className="mt-5 rounded-lg bg-muted/60 px-4 py-3 text-sm">
          <dt className="text-muted-foreground">Participant registration</dt>
          <dd className="font-mono text-base">{participantId}</dd>
        </dl>

        <div className="mt-5 space-y-2 text-base leading-relaxed">
          <p>The following activity may be recorded: <strong>prompts, responses, and agent activity</strong>.</p>
          <p>Selected event data (structured object observations, never raw video) may be stored in <strong>Cognee</strong> for memory and learning analysis.</p>
          <p>Do not enter credentials or sensitive personal information. The camera stays off until you accept.</p>
        </div>

        <fieldset className="mt-6 space-y-4">
          <legend className="sr-only">Required acknowledgements</legend>
          {CHOICES.map((c) => (
            <div key={c.key} className="flex items-start gap-3">
              <Checkbox
                id={c.key}
                checked={!!checked[c.key]}
                onCheckedChange={(v) => setChecked((s) => ({ ...s, [c.key]: v === true }))}
                className="mt-0.5 size-5"
              />
              <Label htmlFor={c.key} className="text-base font-normal leading-snug">{c.text}</Label>
            </div>
          ))}
        </fieldset>

        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}

        <Button size="lg" className="mt-7 h-12 w-full text-base" disabled={!all || busy} onClick={accept}>
          {busy ? "Saving consent…" : "Accept and Start"}
        </Button>
      </section>
    </main>
  );
}
