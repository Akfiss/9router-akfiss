"use client";

import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Reveals a freshly created/rotated Bansos API key exactly once. The
// plaintext only ever exists in the POST/rotate response
// (src/app/api/bansos/users/[id]/keys/route.js, .../keys/[id]/route.js) —
// it is never persisted or re-fetchable, so `keyRecord` is transient
// component state in the caller that must be cleared on close (see
// UsersKeysTab.js's `createdKey` state).
export default function OneTimeKeyModal({ keyRecord, onClose }) {
  const { copied, copy } = useCopyToClipboard(2000);

  return (
    <Modal isOpen={!!keyRecord} title="API Key Created" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
            Save this key now!
          </p>
          <p className="text-sm text-yellow-700 dark:text-yellow-300">
            This is the only time you will see this key. Store it securely.
          </p>
        </div>
        <div className="flex gap-2">
          <Input value={keyRecord?.plaintext || ""} readOnly className="flex-1 font-mono text-sm" />
          <Button
            variant="secondary"
            icon={copied === "created_key" ? "check" : "content_copy"}
            onClick={() => copy(keyRecord?.plaintext || "", "created_key")}
          >
            {copied === "created_key" ? "Copied!" : "Copy"}
          </Button>
        </div>
        <Button onClick={onClose} fullWidth>
          Done
        </Button>
      </div>
    </Modal>
  );
}
