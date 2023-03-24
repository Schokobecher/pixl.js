
#include "mui_scene_dispatcher.h"

#include "amiibolink_scene.h"

#define ADD_SCENE(prefix, name, id) \
    void prefix##_scene_##name##_on_enter(void*); \
    void prefix##_scene_##name##_on_exit(void* context); 
#include "amiibolink_scene_config.h"
#undef ADD_SCENE

const mui_scene_t amiibolink_scene_defines[] = {

#define ADD_SCENE(prefix, name, id) \
    { \
        .scene_id = (AMIIBOLINK_SCENE_##id), \
        .enter_cb = prefix##_scene_##name##_on_enter, \
        .exit_cb = prefix##_scene_##name##_on_exit \
    }, \

#include "amiibolink_scene_config.h"
#undef ADD_SCENE

};