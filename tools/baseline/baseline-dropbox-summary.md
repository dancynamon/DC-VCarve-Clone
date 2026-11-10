# File sweep baseline (before the reliability work, engine at f7364df)

Read-only sweep of the shop archive: 7,339 files. Customer filenames are deliberately not kept here.

| ext | total | ok | partial (silent) | fail |
|---|---|---|---|---|
| tap | 3736 | 3695 | 36 | 5 |
| dxf | 173 | 145 | 21 | 7 |
| crv3d | 1853 | 227 | 1609 | 17 |
| crv | 1577 | 459 | 1118 | 0 |

Classes, most common first: crv3d TOOLPATHS_NOT_IMPORTED 1569; crv TOOLPATHS_NOT_IMPORTED 1111; crv3d UNITS_GUESSED_MM 30;
tap SIM_WRONG_TOOL 17; dxf DROPPED_TEXT 16; crv3d ANCHOR_MISMATCH (fail) 16; crv3d NO_VECTORS 10; dxf EMPTY_FILE (fail) 7;
tap GARBAGE_TEXT 7; tap SIM_EXECUTED_COMMENT_OR_JUNK 6; crv NO_VECTORS 6; dxf NON_INCH_UNITS_NOT_SCALED_2 5;
dxf SPLINE_OFF_TRUE_CURVE 5; tap SIM_WRONG_POSITION 3; tap NOT_GCODE_OLE_CONTAINER (fail) 3; tap BARE_WORD_Z 3; tap G53 3;
tap WORD_L 2; crv3d MODEL_3D_NOT_IMPORTED 2; tap ARC_WITHOUT_CENTER 2; crv UNITS_GUESSED_MM 1; tap ARC_RADIUS_MISMATCH 1;
crv3d NOT_A_CRV_FILE (fail) 1; crv3d BITMAP_NOT_IMPORTED 1; tap SIM_WRONG_FEED 1; tap NO_MOTION (fail) 1; tap EMPTY_FILE (fail) 1.
