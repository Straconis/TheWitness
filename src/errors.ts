/** Messages deliberately written for users; operational errors remain in logs. */
export class UserError extends Error {}
export function commandErrorMessage(error:unknown):string {
 return error instanceof UserError && error.message.length>0 && error.message.length<=500
  ? error.message : "The command failed. Check the bot logs and try again.";
}
