import { useState } from 'react'
import type { JoinResult } from '@kanbanto/model/api'
import { api, errorMessage } from '@/api/client'
import { navigate } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/** Join a board with the access code its owner gave you. */
export function JoinCodeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const join = async () => {
    setBusy(true)
    setError(null)
    try {
      const joined = await api<JoinResult>('POST', '/join', { invite: code })
      onOpenChange(false)
      setCode('')
      // (Codes are for boards; a workspace's invite link pasted here works too.)
      if (joined.kind === 'board') navigate({ page: 'board', id: joined.boardId })
      else navigate({ page: 'workspace', id: joined.workspaceId })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Join a board</DialogTitle>
          <DialogDescription>Enter the access code the board’s owner gave you.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void join()
          }}
        >
          <Input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-1234"
            aria-label="Access code"
            className="text-center font-mono text-lg tracking-widest uppercase"
            maxLength={20}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !code.trim()}>
              Join
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
