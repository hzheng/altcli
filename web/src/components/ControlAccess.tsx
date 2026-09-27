'use client';
import { useState } from 'react';

/** Recorded as the note of the human decision on earlier manual input when taking control. */
export const MANUAL_ACKNOWLEDGEMENT = 'I inspected the host and acknowledge possible prior and background effects.';

/** Taking control is one explicit confirmation: the notes above say what to watch for, and the confirmation lists every step it will
 * perform. Each step is still its own server request, run in order; the first refusal or unknown response stops the rest. The caller
 * keys this by the steps' current state and the view, so a change closes an open confirmation. */
export function TakeControl({ steps, disabled, onConfirm, onPause }: {
  steps: string[]; disabled: boolean; onConfirm: () => void;
  /** Present while the controller is still driving: pausing keeps ownership and can be continued later. */
  onPause?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return <div className="take-control" role="group" aria-label="Take control">
    {!asking ? <div className="pane-buttons">
      <button type="button" className="primary" disabled={disabled} onClick={() => setAsking(true)}>Take control…</button>
      {onPause && <button type="button" className="quiet" disabled={disabled} title="Stop the controller from sending further turns without ending its run. The agent is not interrupted." onClick={onPause}>Pause the controller</button>}
    </div> : <div className="notice" role="region" aria-label="Confirm take control">
      <p><strong>Take control now?</strong> This will:</p>
      <ul>{steps.map((step) => <li key={step}>{step}</li>)}</ul>
      <p>Nothing is interrupted, replayed or marked successful. Keep the notes above in mind.</p>
      <div className="pane-buttons"><button type="button" className="primary" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>Take control now</button>
        <button type="button" className="quiet" onClick={() => setAsking(false)}>Cancel</button></div>
    </div>}
  </div>;
}
