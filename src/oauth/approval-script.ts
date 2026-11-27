/**
 * The one script of the approval page. After Allow or Deny the browser stays on the page until
 * the AI tool has answered, which takes seconds: the script shows that the decision was taken
 * and keeps a second click from being sent, which would use the handle a second time and end on
 * the error page although the first click connected the tool.
 *
 * It is a fixed text: nothing from a request is ever put into it, and the page's policy allows
 * exactly this text by its hash. It reads its sentences from the status element's attributes and
 * sets them as text. Without script the page works as before, only without the feedback. The
 * text holds no `<`, so it can never end its own element.
 *
 * After twelve seconds the ring stops and the line says that this takes longer than usual: a
 * tool that is opened by the redirect instead of loading a page leaves this page standing.
 *
 * The buttons are locked by a flag and by style, never by `disabled`: a disabled button's value
 * is not submitted, and the server needs the decision. A page restored from the browser's
 * back/forward cache is unlocked again.
 */
export const APPROVAL_SCRIPT = `(function(){
var form=document.querySelector("form"),status=document.getElementById("status");
if(!form||!status)return;
var buttons=form.querySelectorAll("button"),pressed=null,sent=false,timer=0;
function each(f){for(var i=buttons.length;i--;)f(buttons[i])}
function lock(on){each(function(b){if(on)b.setAttribute("aria-disabled","true");else b.removeAttribute("aria-disabled")})}
form.addEventListener("click",function(e){var b=e.target&&e.target.closest?e.target.closest("button"):null;if(b)pressed=b});
form.addEventListener("submit",function(e){
if(sent){e.preventDefault();return}
sent=true;
var button=e.submitter||pressed||buttons[0],kind=button&&button.value==="deny"?"deny":"allow";
if(button)button.classList.add("sent");
form.classList.add("busy");
lock(true);
status.textContent=status.getAttribute("data-"+kind);
timer=setTimeout(function(){if(button)button.classList.remove("sent");status.textContent=status.getAttribute("data-late-"+kind)},12000);
});
window.addEventListener("pageshow",function(e){
if(!e.persisted)return;
sent=false;
clearTimeout(timer);
form.classList.remove("busy");
lock(false);
each(function(b){b.classList.remove("sent")});
status.textContent="";
});
})();`;
