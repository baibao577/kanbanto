import { TextT } from '@phosphor-icons/react'
import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CALLOUT_KINDS, CALLOUTS, isCalloutKind } from './callouts'

/** A callout while it is written: its icon opens the kinds to choose from, and the way back to plain text. */
export function CalloutView({ node, editor, getPos, updateAttributes }: ReactNodeViewProps) {
  const kind = isCalloutKind(node.attrs.kind) ? node.attrs.kind : 'note'
  const { icon: Mark, label } = CALLOUTS[kind]
  const plain = () => {
    const pos = getPos()
    if (pos === undefined) return
    editor
      .chain()
      .focus()
      .setTextSelection({ from: pos + 1, to: pos + node.nodeSize - 1 })
      .lift('callout')
      .run()
  }
  return (
    <NodeViewWrapper className="md-callout" data-callout={kind}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!editor.isEditable}>
          <button type="button" contentEditable={false} className="md-callout-icon" aria-label={`${label}. Change the kind`} title="Change the kind">
            <Mark weight="fill" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
          {CALLOUT_KINDS.map((k) => {
            const Kind = CALLOUTS[k].icon
            return (
              <DropdownMenuItem
                key={k}
                data-callout={k}
                onSelect={() => {
                  updateAttributes({ kind: k })
                  editor.commands.focus()
                }}
              >
                <Kind weight="fill" className="text-(--callout)" /> {CALLOUTS[k].label}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={plain}>
            <TextT /> Plain text
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NodeViewContent className="md-callout-body" data-label={label} />
    </NodeViewWrapper>
  )
}
