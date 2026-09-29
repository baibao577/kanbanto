import { useState } from 'react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api/client'
import { navigate } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** New workspace: just a name. Then its page opens, to invite people. */
export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const { id } = await api<{ id: string }>('POST', '/workspaces', { name: name.trim() })
      onOpenChange(false)
      setName('')
      navigate({ page: 'workspace', id })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a workspace</DialogTitle>
          <DialogDescription>
            A place for a team’s boards. Everyone you invite to it can open its boards, without being invited to each one.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-workspace-name">Name</Label>
            <Input id="new-workspace-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme team" required />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              Create workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
