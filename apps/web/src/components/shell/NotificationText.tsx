import type { NotificationView } from '@kanbanto/model/api'

// One notification in words: who did what, to which card, on which board, with the start of what was said. The bell
// and the page of all notifications both show it; what surrounds it (when, whether it is read, what can be done
// with it) is theirs.

/** "Dana Reyes", "Dana Reyes and Priya Nair", "Dana Reyes, Priya Nair and 2 others" */
const people = (names: string[]) =>
  !names.length
    ? 'Someone'
    : names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} and ${names[1]}`
        : `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length === 3 ? 'other' : 'others'}`

/** The words of a description a comment is about, quoted over what the comment says. */
function About({ words }: { words?: string }) {
  if (!words) return null
  return <p className="mt-0.5 line-clamp-1 border-l-2 border-amber-400/70 pl-1.5 text-xs text-muted-foreground italic">{words}</p>
}

/** `roomy`: on the page, where the sentence has room to be a size larger than under the bell. */
export function NotificationText({ n, roomy }: { n: NotificationView; roomy?: boolean }) {
  const main = roomy ? 'text-sm' : 'text-xs'
  return n.kind === 'mention' ? (
    <>
      <p className={main}>
        <span className="font-semibold">{n.actor}</span> mentioned you {n.where === 'description' ? 'in the description of' : 'on'}{' '}
        <span className="font-medium">“{n.task.title}”</span>
        <span className="text-muted-foreground"> · {n.board.name}</span>
      </p>
      <About words={n.about} />
      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
    </>
  ) : n.kind === 'comment' ? (
    <>
      <p className={main}>
        <span className="font-semibold">{n.actor}</span> commented on <span className="font-medium">“{n.task.title}”</span>
        <span className="text-muted-foreground"> · {n.board.name}</span>
      </p>
      <About words={n.about} />
      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
    </>
  ) : n.kind === 'resolved' ? (
    <>
      <p className={main}>
        <span className="font-semibold">{n.actor}</span> resolved your comment on <span className="font-medium">“{n.task.title}”</span>
        <span className="text-muted-foreground"> · {n.board.name}</span>
      </p>
      <About words={n.about} />
      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
    </>
  ) : n.kind === 'change' ? (
    n.changes.length === 1 ? (
      <p className={main}>
        <span className="font-semibold">{n.actor}</span> {n.changes[0]}
        <span className="text-muted-foreground"> · {n.board.name}</span>
      </p>
    ) : (
      <>
        <p className={main}>
          <span className="font-semibold">{n.actor}</span> {n.changes.length ? `made ${n.changes.length} changes to` : 'changed'}{' '}
          <span className="font-medium">“{n.task.title}”</span>
          <span className="text-muted-foreground"> · {n.board.name}</span>
        </p>
        {n.changes.length > 0 && (
          <ul className="mt-0.5 line-clamp-3 list-inside list-disc text-xs text-muted-foreground">
            {n.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
      </>
    )
  ) : n.kind === 'reaction' ? (
    <>
      <p className={main}>
        <span className="font-semibold">{people(n.people)}</span> reacted {n.emoji.join(' ')} to your comment on{' '}
        <span className="font-medium">“{n.task.title}”</span>
        <span className="text-muted-foreground"> · {n.board.name}</span>
      </p>
      {n.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.excerpt}</p>}
    </>
  ) : n.kind === 'rule' ? (
    <>
      <p className={main}>
        <span className="font-medium">“{n.cards[0]?.title ?? n.task.title}”</span>
        {n.cards.length - 1 + n.more > 0 && ` and ${n.cards.length - 1 + n.more} more`} {n.moment || 'was the subject of a rule'}
        <span className="text-muted-foreground"> · {n.board.name}</span>
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        By {n.actor}
        {n.rule.name && ` · Rule: ${n.rule.name}`}
      </p>
      {n.cards.length > 1 && (
        <ul className="mt-0.5 line-clamp-3 list-inside list-disc text-xs text-muted-foreground">
          {n.cards.slice(1).map((c) => (
            <li key={c.id}>{c.title}</li>
          ))}
        </ul>
      )}
    </>
  ) : n.kind === 'reminder' ? (
    <p className={main}>
      ⏰ Reminder: <span className="font-medium">“{n.task.title}”</span>
      <span className="text-muted-foreground">
        {' '}
        · {n.board.name}
        {n.actor && ` · set by ${n.actor}`}
      </span>
    </p>
  ) : (
    <p className={main}>
      <span className="font-semibold">{n.actor}</span> added you to{' '}
      {n.workspace ? (
        <>
          the workspace <span className="font-medium">“{n.workspace.name}”</span>
        </>
      ) : n.board ? (
        <>
          the board <span className="font-medium">“{n.board.name}”</span>
        </>
      ) : (
        'something that’s since been deleted'
      )}
    </p>
  )
}
