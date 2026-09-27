# The Shared Computer

This is a creative project that might have some utility.

The idea is to have a "shared computer". Imagine something like an old shared unix computer. Everyone has a user account and a "home directory" (let's make it the desktop, so that people can actually find the files).

Every program is just a file, written in Javascript or Typescript. Each program can declare a set of resolutions to run at and the "OS" picks the one that best fits the current screen/layout.
Windows are not resizable and pixels are fairly big. A desktop resolution should be 720x480. The OS exposes a basic UI library to the apps. There is no layout (except for basic text wrapping) because of the fixed resolutions.

Apps get a set of default colors to use (they may use other colors, but it is discouraged).

The OS should use the same rendering set up as the apps.

The programs should be isolated from each other and must request permissions to either 1) have access to a folder 2) communicate with another app 3) communicate with a website, there should be a menu in the OS to see the list of granted permissions for a specific app.

Everything on the computer is synced to the cloud and files can be made readable/writable by specific users or the world. (This is one way to share apps). Also ensure symlinks are supported (this is a way for someone to share an app with everyone).

The server should be written in typescript and should actually store a normal folder for each user on the server. It should be structured just like a normal folder, but it has one special sqlite db at the top level for extra metadata. The main website should just be a single page app that connects to whatever server a user is on, think of it like an email. The home directory of a user should be at like /com/simplebox/andrew (which would be the user like andrew@simplebox.com). It should be super easy to make a symlink from an old box to a new box (like if someone migrated between servers.)

For now the main website will be hosted at simplebox.anb.codes

