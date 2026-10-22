import {SOUNDCRAFT_MAX_FRAMES,SOUNDCRAFT_LENGTH_WARNING,SOUNDCRAFT_UNKNOWN_WARNING} from "../exports/soundcraft-limits";

/** Shared browser check for the recording button and editor/excerpt select options. */
export const soundcraftChoiceScript=`
function updateSoundcraftChoice(seconds){
 const warning=!Number.isFinite(seconds)||seconds<0?${JSON.stringify(SOUNDCRAFT_UNKNOWN_WARNING)}:Math.round(seconds*48000)>${SOUNDCRAFT_MAX_FRAMES}?${JSON.stringify(SOUNDCRAFT_LENGTH_WARNING)}:'';
 const choice=document.querySelector('button[data-format="soundcraft"],option[value="soundcraft"]'),notice=document.querySelector('#soundcraft-warning');
 choice.disabled=!!warning;choice.dataset.lengthBlocked=String(!!warning);choice.title=warning;
 notice.textContent=warning;notice.hidden=!warning;
 if(choice.tagName==='OPTION'&&choice.disabled&&choice.selected)document.querySelector('#format').value='audition';
 return !warning;
}
`;
