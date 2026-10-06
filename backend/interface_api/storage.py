import hashlib,io,struct,zlib,json
from pathlib import Path
from datetime import timedelta,datetime,timezone
from minio import Minio
from minio.error import S3Error
import urllib3

MAX_PNG_BYTES=20*1024*1024

def png_info(data):
    if not (24<=len(data)<=MAX_PNG_BYTES) or data[:8]!=b'\x89PNG\r\n\x1a\n' or data[12:16]!=b'IHDR':raise ValueError('Invalid PNG')
    width,height=struct.unpack('!II',data[16:24])
    if not 0<width<=1280 or not 0<height<=800:raise ValueError('Invalid PNG dimensions')
    offset=8;ended=False
    while offset<len(data):
        if offset+12>len(data):raise ValueError('Invalid PNG chunk')
        length=struct.unpack('!I',data[offset:offset+4])[0];end=offset+12+length
        if end>len(data):raise ValueError('Invalid PNG chunk')
        if zlib.crc32(data[offset+4:end-4])!=struct.unpack('!I',data[end-4:end])[0]:raise ValueError('Invalid PNG checksum')
        if data[offset+4:offset+8]==b'IEND':ended=True
        offset=end
    if not ended:raise ValueError('Invalid PNG termination')
    return {'mime_type':'image/png','byte_size':len(data),'width':width,'height':height,'sha256':hashlib.sha256(data).hexdigest()}

def staged_file(root:Path,relative:str):
    path=Path(relative)
    if path.is_absolute() or not path.parts or any(x in ('.','..') for x in path.parts):raise ValueError('Invalid staging path')
    target=root/path
    current=root
    for part in path.parts:
        current=current/part
        if current.is_symlink():raise ValueError('Staging symlink forbidden')
    if not target.resolve().is_relative_to(root.resolve()):raise ValueError('Staging escape')
    return target

class Storage:
    def __init__(self,bucket,internal,external):self.bucket,self.internal,self.external=bucket,internal,external
    @classmethod
    def from_settings(cls,s):
        if not s.storage_configured:return None
        def client(endpoint,secure):return Minio(endpoint,access_key=s.minio_access_key.get_secret_value(),secret_key=s.minio_secret_key.get_secret_value(),secure=secure,region=s.minio_region or 'us-east-1',http_client=urllib3.PoolManager(timeout=urllib3.Timeout(connect=3,read=10),retries=False))
        return cls(s.minio_bucket,client(s.minio_endpoint,s.minio_secure),client(s.minio_public_endpoint,s.minio_public_secure))
    def verify_store(self):
        if not self.internal.bucket_exists(self.bucket):raise ValueError('Bucket unavailable')
        try:
            policy=json.loads(self.internal.get_bucket_policy(self.bucket))
            for stmt in policy.get('Statement',[]):
                principal=stmt.get('Principal')
                if stmt.get('Effect')=='Allow' and (principal=='*' or isinstance(principal,dict) and '*' in (principal.get('AWS') if isinstance(principal.get('AWS'),list) else [principal.get('AWS')])):raise ValueError('Bucket must be private')
        except S3Error as exc:
            if exc.code!='NoSuchBucketPolicy':raise
    def put_png(self,key,path,expected_sha256):
        data=path.read_bytes();info=png_info(data)
        if info['sha256']!=expected_sha256:raise ValueError('Image hash mismatch')
        self.internal.put_object(self.bucket,key,io.BytesIO(data),len(data),content_type='image/png',metadata={'sha256':info['sha256']})
        stat=self.internal.stat_object(self.bucket,key)
        if stat.size!=len(data) or stat.metadata.get('x-amz-meta-sha256')!=info['sha256']:raise ValueError('Upload confirmation mismatch')
        return {**info,'object_key':key}
    def get_png(self,key,sha256):
        response=self.internal.get_object(self.bucket,key)
        try:data=response.read(MAX_PNG_BYTES+1)
        finally:response.close();response.release_conn()
        info=png_info(data)
        if info['sha256']!=sha256:raise ValueError('Stored asset hash mismatch')
        return data
    def sign_get(self,key,ttl_seconds=300):
        self.internal.stat_object(self.bucket,key)
        return {'url':self.external.presigned_get_object(self.bucket,key,expires=timedelta(seconds=ttl_seconds)),'expires_at':(datetime.now(timezone.utc)+timedelta(seconds=ttl_seconds)).isoformat().replace('+00:00','Z')}
    def remove(self,key):self.internal.remove_object(self.bucket,key)
