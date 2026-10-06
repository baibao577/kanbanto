// Times in plain words ("tmr 10:00", "next monday 1pm") are read by the shared model, so the server reads them the
// same way (for a card sent in from a chat). Here they're read on this browser's clock.
export { parseWhen, type When } from '@kanbanto/model/when'
