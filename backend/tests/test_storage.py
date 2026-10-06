import hashlib,struct,zlib
from pathlib import Path
import pytest
from interface_api.storage import Storage, png_info, staged_file

def png(w=2,h=2):
    def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff\0\0'*w)*h))+chunk(b'IEND',b'')

class SDK:
    def __init__(self):self.objects={};self.signed=[]
    def bucket_exists(self,b):return True
    def get_bucket_policy(self,b):
        from minio.error import S3Error
        raise S3Error(response=None,code='NoSuchBucketPolicy',message='none',resource=None,request_id=None,host_id=None)
    def put_object(self,b,k,data,length,**kw):self.objects[k]=(data.read(),kw['metadata'])
    def stat_object(self,b,k):
        from types import SimpleNamespace
        data,metadata=self.objects[k];return SimpleNamespace(size=len(data),metadata={'x-amz-meta-sha256':metadata['sha256']})
    def presigned_get_object(self,b,k,**kwargs):self.signed.append(k);return 'https://objects.example/'+k+'?signed'
    def remove_object(self,b,k):self.objects.pop(k,None)

def test_upload_verified_and_external_signer(tmp_path):
    internal,external=SDK(),SDK();store=Storage('private',internal,external);store.verify_store()
    path=tmp_path/'image.png';path.write_bytes(png());sha=hashlib.sha256(path.read_bytes()).hexdigest()
    info=store.put_png('v1/runs/r/a.png',path,sha)
    assert info['width']==2 and info['sha256']==sha
    assert store.sign_get('v1/runs/r/a.png')['url'].startswith('https://objects.example/')
    assert external.signed and not internal.signed
    with pytest.raises(ValueError):store.put_png('v1/runs/r/b.png',path,'0'*64)

def test_staging_rejects_traversal_symlink_and_bad_png(tmp_path):
    with pytest.raises(ValueError):staged_file(tmp_path,'../x')
    (tmp_path/'link').symlink_to('/tmp')
    with pytest.raises(ValueError):staged_file(tmp_path,'link/a')
    with pytest.raises(ValueError):png_info(b'not png')
