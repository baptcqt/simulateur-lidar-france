from dataclasses import dataclass
@dataclass
class AdapterInfo:
 name:str; enabled:bool=False; license:str='unknown'; hardware:str='optional'; weights_sha256:str|None=None
class AIAdapter:
 info:AdapterInfo
 def predict(self,*args,**kwargs): raise NotImplementedError
