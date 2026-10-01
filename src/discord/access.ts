import type { GuildSettings } from "../storage/settings";
export function mayUseBot(settings:GuildSettings,roles:unknown):boolean{
 if(!settings.restrictAccess)return true;
 return Boolean(settings.accessRoleID&&Array.isArray(roles)&&roles.includes(settings.accessRoleID));
}
export function validateAccess(settings:GuildSettings):void{
 if(settings.restrictAccess!==undefined&&typeof settings.restrictAccess!=="boolean")throw new Error("Invalid access mode.");
 if(settings.accessRoleID!==undefined&&!/^\d{1,25}$/.test(settings.accessRoleID))throw new Error("Invalid Bot Wrangler role ID.");
 if(settings.restrictAccess&&!settings.accessRoleID)throw new Error("Choose a Bot Wrangler role before restricting access.");
}
