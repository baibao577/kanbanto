import { useMemo } from 'react'
import { evaluateRules, listOf, type RuleState } from '@kanbanto/model/rules'
import { useBoard } from './board-context'

/**
 * The board's rules worked out on the board as it is (see model rules.ts): the same for everyone who has it open,
 * whatever they filter or hide, and once for each version of the board however many places ask.
 */
export function useLimits(): RuleState[] {
  const { data, idx } = useBoard()
  return useMemo(() => evaluateRules(idx, data), [idx, data])
}

/** The limits that are about exactly this list: the ones its header shows. */
export const limitsOn = (states: RuleState[], listId: string) => states.filter((s) => listOf(s.rule) === listId)
