; filament_diameter = 1.75;1.75
; filament_density = 1.24;1.04
; filament_type = PLA;PVA
; filament_colour = #00FF00;#FFFFFF
G90
M83
; CHANGE_LAYER
; LINE_WIDTH: 0.4
; LAYER_HEIGHT: 0.2
; FEATURE: Support
T0
G1 X0 Y0 Z0.2
G1 X4 Y0 E0.4
; FEATURE: Support interface
T1
G1 X4 Y4 E0.6
