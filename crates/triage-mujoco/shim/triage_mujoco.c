// Triage's shim over MuJoCo (ROADMAP P3-4): builds a world of rotors (a body on
// a hinge with a disc geom and a motor actuator) with MuJoCo's mjs_* model API,
// no XML, and applies each rotor's motor torque and air drag in mjcb_control.
// Rust reaches MuJoCo only through these functions, so it never depends on the
// layout of MuJoCo's structs. Licensed under GPL-3.0-or-later.
#include <mujoco/mujoco.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct tm_world {
  mjModel *model;
  mjData *data;
  int rotors;
} tm_world;

// Each world keeps its rotors' motor torque and air drag in MuJoCo's own user
// data (d->userdata: torque, drag per rotor), so the one global mjcb_control
// needs no table of worlds and any number of worlds can step on any threads.
static void tm_control(const mjModel *m, mjData *d) {
  int rotors = (int)(m->nuserdata / 2);
  for (int i = 0; i < rotors && i < m->nu; i++) {
    double omega = d->qvel[i];
    double sign = omega < 0 ? -1.0 : 1.0;
    d->ctrl[i] = d->userdata[2 * i] - d->userdata[2 * i + 1] * omega * omega * sign;
  }
}

// Builds a world: rotor i is a disc of radius[i] and mass[i] on a hinge (z axis)
// with viscous damping[i]. Returns NULL and fills error on failure.
tm_world *tm_world_new(int rotors, const double *radius, const double *mass, const double *damping,
                       const double *drag, double timestep, char *error, int error_size) {
  mjSpec *spec = mj_makeSpec();
  if (!spec) {
    snprintf(error, error_size, "mj_makeSpec failed");
    return NULL;
  }
  spec->option.timestep = timestep;
  spec->option.integrator = mjINT_IMPLICITFAST;
  spec->option.disableflags |= mjDSBL_CONTACT | mjDSBL_GRAVITY;
  spec->nuserdata = 2 * rotors;
  mjsBody *world_body = mjs_findBody(spec, "world");
  for (int i = 0; i < rotors; i++) {
    char name[32];
    mjsBody *body = mjs_addBody(world_body, NULL);
    snprintf(name, sizeof name, "rotor%d", i);
    mjs_setName(body->element, name);
    body->pos[0] = 0.2 * i; // apart, though contacts are off anyway

    mjsJoint *hinge = mjs_addJoint(body, NULL);
    snprintf(name, sizeof name, "hinge%d", i);
    mjs_setName(hinge->element, name);
    hinge->type = mjJNT_HINGE;
    hinge->axis[0] = 0;
    hinge->axis[1] = 0;
    hinge->axis[2] = 1;
    hinge->damping[0] = damping[i];

    mjsGeom *disc = mjs_addGeom(body, NULL);
    disc->type = mjGEOM_CYLINDER;
    disc->size[0] = radius[i];
    disc->size[1] = 0.004; // half-height
    disc->mass = mass[i];
    disc->contype = 0;
    disc->conaffinity = 0;

    mjsActuator *motor = mjs_addActuator(spec, NULL);
    snprintf(name, sizeof name, "motor%d", i);
    mjs_setName(motor->element, name);
    motor->trntype = mjTRN_JOINT;
    snprintf(name, sizeof name, "hinge%d", i);
    mjs_setString(motor->target, name);
    motor->gaintype = mjGAIN_FIXED;
    motor->gainprm[0] = 1;
    motor->biastype = mjBIAS_NONE;
    motor->ctrllimited = mjLIMITED_FALSE;
    motor->forcelimited = mjLIMITED_FALSE;
  }
  mjModel *model = mj_compile(spec, NULL);
  if (!model) {
    snprintf(error, error_size, "mj_compile: %s", mjs_getError(spec));
    mj_deleteSpec(spec);
    return NULL;
  }
  mj_deleteSpec(spec);
  mjData *data = mj_makeData(model);
  if (!data) {
    snprintf(error, error_size, "mj_makeData failed");
    mj_deleteModel(model);
    return NULL;
  }
  tm_world *world = calloc(1, sizeof *world);
  world->model = model;
  world->data = data;
  world->rotors = rotors;
  for (int i = 0; i < rotors; i++)
    data->userdata[2 * i + 1] = drag[i];
  mjcb_control = tm_control;
  return world;
}

void tm_world_free(tm_world *world) {
  if (!world)
    return;
  mj_deleteData(world->data);
  mj_deleteModel(world->model);
  free(world);
}

void tm_set_torque(tm_world *world, int rotor, double torque) {
  if (rotor >= 0 && rotor < world->rotors)
    world->data->userdata[2 * rotor] = torque;
}

void tm_step(tm_world *world, int steps) {
  for (int i = 0; i < steps; i++)
    mj_step(world->model, world->data);
}

double tm_time(const tm_world *world) {
  return world->data->time;
}
double tm_timestep(const tm_world *world) {
  return world->model->opt.timestep;
}
double tm_angle(const tm_world *world, int rotor) {
  return world->data->qpos[rotor];
}
double tm_omega(const tm_world *world, int rotor) {
  return world->data->qvel[rotor];
}

// The rotor's moment of inertia about its hinge, as MuJoCo computed it from the geom.
double tm_inertia(const tm_world *world, int rotor) {
  // body 0 is the world; rotor i is body i + 1, its hinge is along z.
  return world->model->body_inertia[3 * (rotor + 1) + 2];
}

const char *tm_version(void) {
  return mj_versionString();
}
