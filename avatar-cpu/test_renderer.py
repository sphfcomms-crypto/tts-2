import hashlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer
import unittest
import wave

import av
import numpy as np
from benchmark import telephone
from phones import PHONES
from renderer import Atlas, read_wav, render
from server import Handler


class FixedPhones:
    backend = "uni2005"
    last_backend = "uni2005"

    def __init__(self, values):
        self.values = np.asarray(values, np.float32)

    def weights(self, wav, lead, frames):
        self.shape = len(wav), lead, frames
        return np.tile(self.values, (frames, 1))


def pcm_wav(samples, rate):
    out = io.BytesIO()
    with wave.open(out, "wb") as f:
        f.setparams((1, 2, rate, 0, "NONE", ""))
        f.writeframes(np.asarray(samples, dtype="<i2").tobytes())
    return out.getvalue()


class FrameTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        clip = root / "unit"
        clip.mkdir()
        w, h, n = 96, 64, 7
        base = np.full((n, w*h*3//2), 128, np.uint8)
        for i in range(n):
            base[i,:w*h] = 38+8*i
        master = root / "unit.mp4"
        subprocess.run(["ffmpeg","-nostdin","-v","error","-f","rawvideo","-pixel_format","yuv420p",
                        "-video_size", f"{w}x{h}", "-framerate","25","-i","-","-c:v","libx264","-crf","0",
                        "-threads","1","-y",str(master)],input=base.tobytes(),check=True)
        # Deliberately store a different class order from the acoustic model.
        stored = list(reversed(PHONES))
        patches = np.empty((n,len(stored),24*16*3//2),np.uint8)
        for i in range(n):
            for k,_ in enumerate(stored):
                patches[i,k]=50+11*k+i
        np.save(clip / "patches.npy",patches)
        meta=dict(name="unit",width=w,height=h,frames=n,fps=25,roi=[18,22,24,16],
                  phones=stored,source_sha256=hashlib.sha256(master.read_bytes()).hexdigest())
        (clip/"meta.json").write_text(json.dumps(meta))
        cls.atlas=Atlas(clip,root,root/"cache",PHONES)
        cls.rest=np.eye(len(PHONES),dtype=np.float32)[PHONES.index("REST")]
        cls.patches=patches

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_body_and_chroma_stay_on_the_source_frame_through_wrap(self):
        a=self.atlas
        for start,which in [(5,5),(6,6),(7,5),(11,1),(12,0)]:
            self.assertEqual(a.frame_index(start),which)
            img=a.draw(start,self.rest).ravel()
            self.assertEqual(img[0],a.base[which,0])
            np.testing.assert_array_equal(a.picture(start,self.rest).to_ndarray().ravel(),img)
            y,u,v=img[:96*64],img[96*64:96*64+48*32],img[-48*32:]
            level=self.patches[which,-1,0]
            self.assertTrue(np.all(y.reshape(64,96)[22:38,18:42]==level))
            self.assertTrue(np.all(u.reshape(32,48)[11:19,9:21]==level))
            self.assertTrue(np.all(v.reshape(32,48)[11:19,9:21]==level))
            self.assertEqual(img[22*96+17],a.base[which,22*96+17])

    def test_fragmented_video_has_exact_pts_even_for_partial_last_frame(self):
        p=FixedPhones(self.rest)
        # 60ms lead, 40ms tail, a partial third output frame.
        data,n,_=render(self.atlas,p,pcm_wav(np.ones(5281)*1300,24000),11,60,40)
        self.assertEqual(n,4)
        self.assertEqual(p.shape[1:],(960,4))
        self.assertIn(b"moof",data)
        with av.open(io.BytesIO(data)) as m:
            frames=list(m.decode(video=0))
            np.testing.assert_allclose([float(f.pts*f.time_base) for f in frames],[0,.04,.08,.12])
            self.assertEqual(len(m.streams.audio),0)

    def test_two_viseme_interpolation_and_browser_mulaw(self):
        w=self.rest.copy()*.55
        w[PHONES.index("A")]=.45
        self.assertEqual(self.atlas.draw(2,w).shape,(96,96))
        signal=np.sin(np.arange(11200)*.023)*.2
        decoded,hz=read_wav(telephone(signal))
        self.assertEqual(hz,16000)
        self.assertLess(np.max(abs(decoded-signal)),.006)
        data,n,_=render(self.atlas,FixedPhones(w),telephone(signal),4,200,100)
        self.assertEqual(n,10)
        self.assertTrue(data.startswith(b"\x00"))
        with self.assertRaises(ValueError): read_wav(b"RIFF"+bytes(88))

    def test_authenticated_http_matches_fragment_contract_and_fails_without_remapping(self):
        engine = SimpleNamespace(clips={"unit":self.atlas}, model=FixedPhones(self.rest),
                                 threads=1, slots=threading.BoundedSemaphore(1),
                                 lock=threading.Lock(), requests=0)
        with ThreadingHTTPServer(("127.0.0.1",0), Handler) as http:
            http.key, http.engine = b"test-key", engine
            thread=threading.Thread(target=http.serve_forever,daemon=True)
            thread.start()
            url=f"http://127.0.0.1:{http.server_port}"
            try:
                with self.assertRaises(HTTPError) as err: urlopen(url+"/health")
                self.assertEqual(err.exception.code,401)
                payload=telephone(np.ones(11200)*.075)
                headers={"x-avatar-key":"test-key","Content-Type":"audio/wav"}
                base=url+"/speak?audio=0&start=9&lead_ms=200&tail_ms=100&clip="
                with urlopen(Request(base+"unit",data=payload,headers=headers)) as r:
                    self.assertEqual(r.headers["X-Frames"],"10")
                    self.assertEqual(r.headers["X-Next-Start"],"7")
                    self.assertEqual(r.headers["X-Avatar-Renderer"],"cpu")
                    self.assertEqual(r.headers["X-Avatar-Acoustic"],"uni2005")
                    self.assertIn(b"moof",r.read())
                with self.assertRaises(HTTPError) as err:
                    urlopen(Request(base+"not_installed",data=payload,headers=headers))
                self.assertEqual(err.exception.code,404)
            finally:
                http.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
