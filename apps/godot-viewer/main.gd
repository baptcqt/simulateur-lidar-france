extends Node3D
var speed=35.0
func _ready():
 var args=OS.get_cmdline_user_args(); var path=""
 for i in range(args.size()-1):
  if args[i]=="--path": path=args[i+1]
 if path!="":
  var doc=GLTFDocument.new(); var state=GLTFState.new()
  if doc.append_from_file(path,state)==OK: add_child(doc.generate_scene(state))
func _process(delta):
 var v=Vector3.ZERO
 if Input.is_key_pressed(KEY_W): v.z-=1
 if Input.is_key_pressed(KEY_S): v.z+=1
 if Input.is_key_pressed(KEY_A): v.x-=1
 if Input.is_key_pressed(KEY_D): v.x+=1
 if Input.is_key_pressed(KEY_Q): v.y-=1
 if Input.is_key_pressed(KEY_E): v.y+=1
 $Camera3D.translate(v.normalized()*speed*delta)
