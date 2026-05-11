(function(){
  function $(id){ return document.getElementById(id); }

  function ready(fn){
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function(){
    const callbar = document.querySelector('.callbar');
    if(!callbar) return;

    const mic = $('btn-toggle-mic');
    const cam = $('btn-toggle-cam');
    const share = $('btn-share-screen');
    const copy = $('btn-copy-call-id');
    const leave = $('btn-leave-call');

    if(mic) mic.textContent = 'Mute';
    if(cam) cam.textContent = 'Video';
    if(share) share.textContent = 'Screen';
    if(copy) copy.textContent = 'Invite';
    if(leave) leave.textContent = 'Leave';

    if(!$('btn-deafen')){
      const deafen = document.createElement('button');
      deafen.id = 'btn-deafen';
      deafen.textContent = 'Deafen';
      if(cam) callbar.insertBefore(deafen, cam);
      else callbar.insertBefore(deafen, callbar.firstChild);

      let deafened = false;
      deafen.addEventListener('click', function(){
        deafened = !deafened;
        document.querySelectorAll('.tile video').forEach(function(video){
          if(video.id !== 'local-video') video.muted = deafened;
        });
        deafen.classList.toggle('off', deafened);
        deafen.textContent = deafened ? 'Deafened' : 'Deafen';
      });
    }

    if(mic){
      mic.addEventListener('click', function(){
        const off = mic.textContent.toLowerCase().includes('muted') || mic.textContent.toLowerCase().includes('unmute');
        mic.classList.toggle('off');
        mic.textContent = mic.classList.contains('off') ? 'Unmute' : 'Mute';
      });
    }

    if(cam){
      cam.addEventListener('click', function(){
        cam.classList.toggle('active');
        cam.textContent = cam.classList.contains('active') ? 'Video On' : 'Video';
      });
    }

    if(share){
      share.addEventListener('click', function(){
        share.classList.toggle('active');
        share.textContent = share.classList.contains('active') ? 'Sharing' : 'Screen';
      });
    }

    if(copy){
      copy.addEventListener('click', function(){
        copy.textContent = 'Copied';
        setTimeout(function(){ copy.textContent = 'Invite'; }, 1400);
      });
    }

    const observer = new MutationObserver(function(){
      document.querySelectorAll('.tile video').forEach(function(video){
        video.setAttribute('playsinline','');
      });
    });
    observer.observe(document.body,{childList:true,subtree:true});
  });
})();
